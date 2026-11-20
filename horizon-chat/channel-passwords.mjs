import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const derive=promisify(scrypt);
export function createChannelPasswords(db,ownerId){
  db.exec(`CREATE TABLE IF NOT EXISTS channel_passwords(conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,salt TEXT NOT NULL,hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS channel_creators(channel_id INTEGER PRIMARY KEY REFERENCES server_channels(id) ON DELETE CASCADE,account_id INTEGER NOT NULL REFERENCES accounts(id));`);
  const find=db.prepare('SELECT salt,hash FROM channel_passwords WHERE conversation_id=?');
  const channel=db.prepare('SELECT c.id,s.owner_id AS ownerId,cc.account_id AS creatorId FROM server_channels c JOIN chat_servers s ON s.id=c.server_id LEFT JOIN channel_creators cc ON cc.channel_id=c.id WHERE c.conversation_id=? AND c.kind<>\'separator\'');
  const unlocked=new Map(),attempts=new Map();
  const allowed=(token,conversation,account)=>account===ownerId()||!find.get(conversation)||unlocked.get(token)?.get(conversation)===find.get(conversation).hash;
  return {
    allowed,
    info(token,conversation,account){const c=channel.get(conversation);return {passwordProtected:Boolean(find.get(conversation)),locked:!allowed(token,conversation,account),canSetPassword:Boolean(c&&(c.ownerId===account||c.creatorId===account))};},
    creator(channelId,account){db.prepare('INSERT OR IGNORE INTO channel_creators VALUES (?,?)').run(channelId,account);},
    async change(token,conversation,account,input){
      const c=channel.get(conversation);if(!c)return {status:404,error:'Channel not found.'};
      if(c.ownerId!==account&&c.creatorId!==account)return {status:403,error:'Only the channel creator or server owner can set its password.'};
      if(typeof input?.enabled!=='boolean')return {status:400,error:'Choose whether this channel needs a password.'};
      if(!input.enabled){db.prepare('DELETE FROM channel_passwords WHERE conversation_id=?').run(conversation);return {};}
      if(input.password===''&&find.get(conversation))return {};
      if(typeof input.password!=='string'||input.password.length<4||input.password.length>128)return {status:400,error:'Use a password between 4 and 128 characters.'};
      const salt=randomBytes(24).toString('hex'),hash=(await derive(input.password,salt,64)).toString('hex');
      db.prepare('INSERT INTO channel_passwords VALUES (?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET salt=excluded.salt,hash=excluded.hash').run(conversation,salt,hash);
      if(!unlocked.has(token))unlocked.set(token,new Map());unlocked.get(token).set(conversation,hash);return {};
    },
    async unlock(token,conversation,account,input){
      if(allowed(token,conversation,account))return {};
      const key=account+':'+conversation,now=Date.now();
      for(const [key,entry] of attempts)if(entry.until<now)attempts.delete(key);
      const attempt=attempts.get(key)||{count:0,until:now+60000};
      if(attempt.count>=5)return {status:429,error:'Too many attempts. Try again in a minute.'};
      attempt.count++;attempts.set(key,attempt);
      if(typeof input?.password!=='string'||input.password.length>128)return {status:400,error:'Enter the channel password.'};
      const stored=find.get(conversation),hash=await derive(input.password,stored.salt,64);
      if(!timingSafeEqual(hash,Buffer.from(stored.hash,'hex')))return {status:403,error:'Incorrect channel password.'};
      if(unlocked.size>4096)unlocked.delete(unlocked.keys().next().value);
      if(!unlocked.has(token))unlocked.set(token,new Map());unlocked.get(token).set(conversation,stored.hash);attempts.delete(key);return {};
    }
  };
}
