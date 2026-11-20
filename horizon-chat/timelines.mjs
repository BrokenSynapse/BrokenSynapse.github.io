const gregorian = {
  mode: 'gregorian',
  months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
    .map((name, index) => ({ name, days: [31,28,31,30,31,30,31,31,30,31,30,31][index] })),
  weekdays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  hoursPerDay: 24, minutesPerHour: 60, eras: [],
};
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const fail = (status, error) => ({ status, error });

function monthDays(calendar, year, month) {
  const leap = calendar.mode === 'gregorian' && month === 2 && year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return leap ? 29 : calendar.months[month - 1]?.days;
}

function validDate(calendar, { year, month, day }) {
  return integer(year, -999999, 999999) && integer(month, 1, calendar.months.length) &&
    integer(day, 1, monthDays(calendar, year, month));
}

function cleanCalendar(input) {
  if (!input || !['gregorian', 'custom'].includes(input.mode)) return null;
  if (input.mode === 'gregorian') return gregorian;
  if (!Array.isArray(input.months) || !integer(input.months.length, 1, 24) ||
      !Array.isArray(input.weekdays) || !integer(input.weekdays.length, 1, 16) ||
      !integer(input.hoursPerDay, 1, 100) || !integer(input.minutesPerHour, 1, 100) ||
      !Array.isArray(input.eras) || input.eras.length > 24) return null;
  const months = input.months.map(row => ({ name: text(row?.name, 40), days: row?.days }));
  const weekdays = input.weekdays.map(name => text(name, 24));
  const eras = input.eras.map(row => ({ name: text(row?.name, 40), start: row?.start }));
  if (months.some(row => !row.name || !integer(row.days, 1, 120)) || weekdays.some(name => !name) ||
      eras.some(row => !row.name || !integer(row.start, -999999, 999999)) ||
      new Set(eras.map(row => row.start)).size !== eras.length) return null;
  eras.sort((a, b) => a.start - b.start);
  return { mode: 'custom', months, weekdays, hoursPerDay: input.hoursPerDay, minutesPerHour: input.minutesPerHour, eras };
}

export function createTimelines(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_time_system (
      channel_id INTEGER PRIMARY KEY REFERENCES server_channels(id) ON DELETE CASCADE,
      calendar TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channel_timeline_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL REFERENCES server_channels(id) ON DELETE CASCADE,
      creator_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      day INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS channel_timeline_order ON channel_timeline_events(channel_id, year, month, day, id);
  `);
  const readSystem = db.prepare('SELECT calendar FROM channel_time_system WHERE channel_id = ?');
  const writeSystem = db.prepare('INSERT INTO channel_time_system VALUES (?, ?) ON CONFLICT(channel_id) DO UPDATE SET calendar = excluded.calendar');
  const list = db.prepare('SELECT id, creator_id AS creator, year, month, day, title, description FROM channel_timeline_events WHERE channel_id = ? ORDER BY year, month, day, id');
  const find = db.prepare('SELECT creator_id AS creator FROM channel_timeline_events WHERE channel_id = ? AND id = ?');
  const insert = db.prepare('INSERT INTO channel_timeline_events(channel_id, creator_id, year, month, day, title, description) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const update = db.prepare('UPDATE channel_timeline_events SET year = ?, month = ?, day = ?, title = ?, description = ? WHERE channel_id = ? AND id = ?');
  const remove = db.prepare('DELETE FROM channel_timeline_events WHERE channel_id = ? AND id = ?');
  const calendar = id => JSON.parse(readSystem.get(id)?.calendar ?? 'null') || gregorian;
  const mayEdit = (policy, creator) => policy.manage || (policy.create && policy.account === creator);

  return {
    view(policy) {
      return { calendar: calendar(policy.id), canCreate: policy.create, canManage: policy.manage,
        events: list.all(policy.id).map(({ creator, ...event }) => ({ ...event, editable: mayEdit(policy, creator) })) };
    },
    change(policy, data) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = mutate(policy, data);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };

  function mutate(policy, data) {
    if (data.action === 'calendar') {
      if (!policy.manage) return fail(403, 'You cannot edit this time system.');
      const config = cleanCalendar(data.calendar);
      if (!config) return fail(400, 'Enter valid months, weekdays, time units, and eras.');
      if (list.all(policy.id).some(event => !validDate(config, event))) {
        return fail(409, 'This calendar would invalidate an existing event date. Adjust that event first.');
      }
      writeSystem.run(policy.id, JSON.stringify(config));
      return {};
    }
    if (!['create', 'update', 'delete'].includes(data.action)) return fail(400, 'Invalid timeline action.');
    if (data.action !== 'create') {
      const event = integer(data.id, 1, Number.MAX_SAFE_INTEGER) && find.get(policy.id, data.id);
      if (!event) return fail(404, 'Event not found.');
      if (!mayEdit(policy, event.creator)) return fail(403, 'You cannot edit this event.');
    } else if (!policy.create) return fail(403, 'You cannot add events to this timeline.');
    if (data.action === 'delete') {
      remove.run(policy.id, data.id);
      return {};
    }
    const title = text(data.title, 120);
    const description = text(data.description, 4000);
    if (!title || !validDate(calendar(policy.id), data)) return fail(400, 'Enter an event name and a valid date.');
    const values = [data.year, data.month, data.day, title, description];
    if (data.action === 'update') update.run(...values, policy.id, data.id);
    else insert.run(policy.id, policy.account, ...values);
    return {};
  }
}
