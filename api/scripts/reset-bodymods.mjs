import { getSheet, putSheet, appendAudit } from '../lib/store.js';

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const keepInstalled = args.has('--keep-installed');

const SLOT_HEADERS = [
  'slot',
  'label',
  'parentSlot',
  'region',
  'ord',
  'note',
  'category',
  'isSlot',
  'accepts',
  'blocks',
  'exclusiveGroup'
];

const CATEGORY_HEADERS = [
  'id',
  'label',
  'parent',
  'region',
  'canInstall',
  'accepts',
  'blocks',
  'note'
];

const MOD_HEADERS = [
  'mid',
  'slot',
  'nm',
  'cat',
  'st',
  'mfg',
  'desc',
  'fx',
  'draw',
  'rare',
  'compat',
  'diff',
  'vis',
  'lockChild',
  'locks',
  'replace',
  'cost',
  'unCost',
  'validSlots',
  'supportType',
  'lmexCertified',
  'cardiovascularOutput',
  'pressureTolerance',
  'renalClearance',
  'hepaticProcessing',
  'thermalLoad',
  'neuralBuffer',
  'sleepState',
  'glucoseElectrolyte',
  'supportNotes',
  'img',
  'image',
  'imageUrl',
  'layer',
  'z',
  'opacity'
];

const INSTALLED_HEADERS = ['id','cid','profileId','baseMesh','meshPath','mid','slot','name','note','t','blob'];

const TREE = {
  body: {
    head: {
      scalp: {},
      hair: {},
      face: {
        eyes: {},
        ears: {},
        nose: {},
        mouth: {},
        jaw: {}
      },
      skull: {},
      brain: {
        cerebrum: {},
        corpus_callosum: {},
        cerebellum: {},
        brainstem: {},
        limbic_system: {},
        pituitary: {},
        neural_interface: {}
      }
    },
    neck: {
      throat: {},
      spine_neck: {}
    },
    torso: {
      chest: {
        heart: {},
        lungs: {},
        ribs: {}
      },
      abdomen: {
        stomach: {},
        liver: {},
        kidneys: {},
        intestines: {}
      },
      back: {
        spine_torso: {}
      },
      core: {}
    },
    pelvis: {
      hips: {},
      genitalia: {},
      bladder: {},
      tailbone: {}
    },
    left_arm: {
      upper_arm: {},
      elbow: {},
      forearm: {},
      wrist: {},
      hand: {
        palm: {},
        thumb: {},
        index: {},
        middle: {},
        ring: {},
        pinky: {}
      }
    },
    right_arm: {
      upper_arm: {},
      elbow: {},
      forearm: {},
      wrist: {},
      hand: {
        palm: {},
        thumb: {},
        index: {},
        middle: {},
        ring: {},
        pinky: {}
      }
    },
    left_leg: {
      thigh: {},
      knee: {},
      calf: {},
      ankle: {},
      foot: {
        sole: {},
        big_toe: {},
        second_toe: {},
        middle_toe: {},
        fourth_toe: {},
        little_toe: {}
      }
    },
    right_leg: {
      thigh: {},
      knee: {},
      calf: {},
      ankle: {},
      foot: {
        sole: {},
        big_toe: {},
        second_toe: {},
        middle_toe: {},
        fourth_toe: {},
        little_toe: {}
      }
    },
    surface: {
      skin: {},
      body_hair: {},
      scars: {},
      tattoos: {},
      pigmentation: {}
    },
    subdermal: {
      general: {},
      armor: {},
      mesh: {},
      ports: {},
      chips: {},
      reservoirs: {},
      emitters: {},
      cosmetic_underlays: {},
      sensory_nodes: {}
    },
    structure: {
      skeleton: {},
      musculature: {},
      tendons: {},
      ligaments: {},
      connective_tissue: {}
    },
    systems: {
      nervous: {},
      cardiovascular: {},
      respiratory: {},
      immune: {},
      endocrine: {},
      digestive: {},
      renal: {},
      hepatic: {},
      metabolic: {},
      thermal: {},
      glucose_electrolyte: {}
    },
    genetic: {
      genome: {},
      epigenetics: {},
      cellular_repair: {}
    }
  }
};

const COMPAT = {
  body: { accepts: 'organic,cybernetic,genetic,synthetic,systemic' },
  'left_arm': { accepts: 'organic_arm,cyber_arm,synthetic_arm' },
  'right_arm': { accepts: 'organic_arm,cyber_arm,synthetic_arm' },
  'left_arm.hand': { accepts: 'organic_hand,cyber_hand,synthetic_hand', blocks: 'organic_hand_requires_organic_or_hybrid_arm' },
  'right_arm.hand': { accepts: 'organic_hand,cyber_hand,synthetic_hand', blocks: 'organic_hand_requires_organic_or_hybrid_arm' },
  'left_arm.wrist': { accepts: 'organic_interface,cyber_interface,synthetic_interface' },
  'right_arm.wrist': { accepts: 'organic_interface,cyber_interface,synthetic_interface' },
  'left_leg': { accepts: 'organic_leg,cyber_leg,synthetic_leg' },
  'right_leg': { accepts: 'organic_leg,cyber_leg,synthetic_leg' },
  'left_leg.foot': { accepts: 'organic_foot,cyber_foot,synthetic_foot', blocks: 'organic_foot_requires_organic_or_hybrid_leg' },
  'right_leg.foot': { accepts: 'organic_foot,cyber_foot,synthetic_foot', blocks: 'organic_foot_requires_organic_or_hybrid_leg' },
  'left_leg.ankle': { accepts: 'organic_interface,cyber_interface,synthetic_interface' },
  'right_leg.ankle': { accepts: 'organic_interface,cyber_interface,synthetic_interface' },
  'head.brain': { accepts: 'organic_neural,cyber_neural,synthetic_neural' },
  'head.brain.neural_interface': { accepts: 'cyber_neural,synthetic_neural,organic_neural_bridge' },
  surface: { accepts: 'organic_dermal,synthetic_dermal,subdermal,cyber_dermal' },
  subdermal: { accepts: 'subdermal,cyber_dermal,synthetic_dermal' },
  genetic: { accepts: 'genetic' }
};

const REGION_BY_TOP = {
  head: 'head',
  neck: 'neck',
  torso: 'torso',
  pelvis: 'pelvis',
  left_arm: 'left_arm',
  right_arm: 'right_arm',
  left_leg: 'left_leg',
  right_leg: 'right_leg',
  surface: 'surface',
  subdermal: 'subdermal',
  structure: 'structure',
  systems: 'systems',
  genetic: 'genetic'
};

function titleFromId(id) {
  return id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function categoryOf(id, parts) {
  if (parts.includes('hand') || parts.includes('wrist')) return 'hand';
  if (parts.includes('foot') || parts.includes('ankle')) return 'foot';
  if (parts.includes('brain') || parts.includes('neural_interface')) return 'neural';
  if (parts[0] === 'surface') return 'surface';
  if (parts[0] === 'subdermal') return 'subdermal';
  if (parts[0] === 'systems') return 'system';
  if (parts[0] === 'genetic') return 'genetic';
  if (parts[0] === 'structure') return 'structure';
  return parts[0] || 'body';
}

function noteFor(id, label, parentId) {
  if (!parentId) return 'Root body category and full-body install target.';
  return `${label} slot under ${titleFromId(parentId.split('.').slice(-1)[0])}.`;
}

function walkTree(node, parentId = '', rows = []) {
  for (const [key, children] of Object.entries(node)) {
    const id = parentId && parentId !== 'body' ? `${parentId}.${key}` : key;
    const parts = id.split('.');
    const top = id === 'body' ? 'body' : parts[0];
    const region = id === 'body' ? 'body' : REGION_BY_TOP[top] || top || 'body';
    const compat = COMPAT[id] || COMPAT[key] || {};
    const label = titleFromId(key);
    rows.push({
      slot: id,
      label,
      parentSlot: parentId,
      region,
      ord: rows.length + 1,
      note: noteFor(id, label, parentId),
      category: categoryOf(id, parts),
      isSlot: 'TRUE',
      accepts: compat.accepts || 'organic,cybernetic,genetic,synthetic',
      blocks: compat.blocks || '',
      exclusiveGroup: id
    });
    walkTree(children, id, rows);
  }
  return rows;
}

function buildCategories(slots) {
  const byCategory = new Map();
  for (const row of slots) {
    if (!byCategory.has(row.category)) {
      byCategory.set(row.category, {
        id: row.category,
        label: titleFromId(row.category),
        parent: row.category === 'body' ? '' : 'body',
        region: row.region,
        canInstall: 'TRUE',
        accepts: row.accepts,
        blocks: '',
        note: 'Generated from the BodyMods slot taxonomy.'
      });
    }
  }
  return [...byCategory.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const before = {
  mods: getSheet('mods').rows.length,
  bodyInstalled: getSheet('bodyInstalled').rows.length,
  bodySlots: getSheet('bodySlots').rows.length,
  bodyCategories: getSheet('bodyCategories').rows.length
};

const bodySlots = walkTree(TREE);
const bodyCategories = buildCategories(bodySlots);

const after = {
  mods: 0,
  bodyInstalled: keepInstalled ? before.bodyInstalled : 0,
  bodySlots: bodySlots.length,
  bodyCategories: bodyCategories.length
};

console.log(JSON.stringify({
  ok: true,
  mode: apply ? 'apply' : 'dry-run',
  keepInstalled,
  before,
  after,
  samples: {
    armHandRule: {
      parentSlot: 'left_arm',
      childSlot: 'left_arm.hand',
      leftArmAccepts: COMPAT.left_arm.accepts,
      leftHandAccepts: COMPAT['left_arm.hand'].accepts,
      leftHandBlocks: COMPAT['left_arm.hand'].blocks
    },
    firstSlots: bodySlots.slice(0, 10)
  }
}, null, 2));

if (!apply) {
  console.log('\nDry run only. Re-run with --apply to write these changes.');
  process.exit(0);
}

putSheet('mods', [], MOD_HEADERS);
putSheet('bodySlots', bodySlots, SLOT_HEADERS);
putSheet('bodyCategories', bodyCategories, CATEGORY_HEADERS);
if (!keepInstalled) putSheet('bodyInstalled', [], INSTALLED_HEADERS);

appendAudit('maintenance.resetBodyMods', 'script', {
  keepInstalled,
  before,
  after
});

console.log(`\nApplied: cleared mods, ${keepInstalled ? 'kept' : 'cleared'} installed body entries, seeded ${bodySlots.length} body slots and ${bodyCategories.length} categories.`);
