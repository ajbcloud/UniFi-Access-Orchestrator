'use strict';

/**
 * Catalog of Z-Wave deadbolt models and their per-model procedures.
 *
 * Two uses:
 *   1. Auto-identify: a paired node's manufacturerId:productType:productId is
 *      matched to a model so the dashboard shows a clean name (the zwave-js
 *      device DB labels some modules with a combined multi-model string).
 *   2. Add Deadbolt: the operator picks a manufacturer + model up front, and
 *      the pairing wizard shows THAT model's enroll gesture and pre-selects
 *      its default security mode; the locks table shows its exclude + reset
 *      gestures.
 *
 * The catalog is DATA, not control code. Z-Wave exclusion is generic
 * (Controller.beginExclusion removes any node regardless of brand), so only
 * the on-device gesture TEXT differs per model. `default_security` maps to the
 * pairing security mode (auto|s2|s0). `confirmed` is false for gestures we
 * could not pin to an authoritative source; the UI labels those "verify
 * against the lock's manual" rather than presenting them as certain.
 *
 * Sources: manufacturer manuals (Schlage/Allegion, Yale, Kwikset, Ultraloq,
 * Weiser/Baldwin), z-wavealliance.org product pages, Alarm Grid / True Home
 * KБ inclusion+reset guides, and zwave-js device-DB ids. Security classes:
 * 500-series modules generally join S0; Z-Wave Plus v2 / 700-series join S2.
 */

// Match keys are lower-case manufacturerId:productType:productId hex4.
const CATALOG = Object.freeze([
  {
    manufacturer: 'Schlage',
    manufacturer_id: '0x003b',
    models: [
      {
        key: 'schlage-be469zp',
        name: 'Schlage BE469ZP Touchscreen Deadbolt',
        match: ['0x003b:0x0001:0x0469'],
        default_security: 's2',
        confirmed: true,
        enroll: 'Put the controller in Add mode, then on the lock keypad press the Schlage (logo) button, enter the 6-digit programming code from the label, then press 0. A solid green check means it joined.',
        exclude: 'Put the controller in Remove/Exclude mode, then press the Schlage button and enter the 6-digit programming code.',
        reset: 'Remove the battery cover and hold the button on the inside PCB for about 7 seconds until the LED lights; it blinks red 3 times on success. Run Unpair on the controller first.',
        quirk: 'S2-capable, but it frequently joins at S0 instead. That is still encrypted and fine; pick Auto.',
      },
      {
        key: 'schlage-be469',
        name: 'Schlage BE469 / BE468 (non-ZP)',
        match: [],
        default_security: 's0',
        confirmed: true,
        enroll: 'Put the controller in Add mode, then press the Schlage button, enter the 6-digit programming code, then press 0.',
        exclude: 'Put the controller in Remove mode, then press the Schlage button and enter the 6-digit programming code.',
        reset: 'Hold the button on the inside PCB about 7 seconds until the LED lights. Run Unpair first.',
        quirk: 'Original 500-series; joins at S0.',
      },
    ],
  },
  {
    manufacturer: 'Yale',
    manufacturer_id: '0x0129',
    models: [
      {
        key: 'yale-assure-zw2',
        name: 'Yale Assure Deadbolt (ZW2)',
        match: ['0x0129:0x8002:0x0600', '0x0129:0x8002:0x1600', '0x0129:0x8002:0x4600'],
        default_security: 's0',
        confirmed: true,
        enroll: 'Put the controller in Add mode, then on the lock enter [Master PIN] # 7 # 1 #. Start within about 6 feet of the stick. It joins at S0, which is normal for this module.',
        exclude: 'Put the controller in Remove mode, then on the lock enter [Master PIN] # 7 # 3 #.',
        reset: 'Remove the battery cover, batteries, and the inside cover to reach the reset button by the cable connector; hold it while reinserting the batteries, at least 3 seconds. Resets the Master PIN to 12345678 and clears Z-Wave.',
        quirk: 'ZW / ZW2 (500-series) module joins at S0. Exclude or factory-reset first if it was ever paired.',
      },
      {
        key: 'yale-assure-zw3',
        name: 'Yale Assure (ZW3 / 700-series)',
        match: [],
        default_security: 's2',
        confirmed: true,
        enroll: 'Put the controller in Add mode, then on the lock enter [Master PIN] # 7 # 1 #. For S2, scan the DSK/QR on the module or enter the 5-digit PIN when prompted.',
        exclude: 'Put the controller in Remove mode, then on the lock enter [Master PIN] # 7 # 3 #.',
        reset: 'Hold the interior reset button while repowering; resets the Master PIN to 12345678.',
        quirk: 'ZW3 700-series joins at S2, but its S2 bootstrap can wedge; if it fails, exclude and re-pair choosing S0.',
      },
    ],
  },
  {
    manufacturer: 'Kwikset',
    manufacturer_id: '0x0090',
    models: [
      {
        key: 'kwikset-smartcode',
        name: 'Kwikset SmartCode (910/912/914/916)',
        match: [],
        default_security: 's0',
        confirmed: true,
        enroll: 'Put the controller in Add mode, open the interior battery cover, and press button A once (the LED lights for Add mode). Pair within a few feet.',
        exclude: 'Put the controller in Remove mode, then press button A once.',
        reset: 'Remove the battery pack, hold the Program button while reinserting it (about 30 seconds) until it beeps and the LED flashes red, then press Program once more.',
        quirk: '500-series SmartCode joins at S0.',
      },
      {
        key: 'kwikset-620',
        name: 'Kwikset Home Connect 620',
        match: [],
        default_security: 's2',
        confirmed: true,
        enroll: 'Put the controller in Add mode, press button A once, and scan the SmartStart/DSK QR code for S2.',
        exclude: 'Put the controller in Remove mode, then press button A once.',
        reset: 'Hold the Program button while reinserting the battery pack (~30s), then press Program once more.',
        quirk: '700-series; joins at S2 with SmartStart.',
      },
    ],
  },
  {
    manufacturer: 'Ultraloq',
    manufacturer_id: '0x0452',
    models: [
      {
        key: 'ultraloq-ubolt-pro',
        name: 'Ultraloq U-Bolt Pro Z-Wave',
        match: ['0x0452:0x0004:0x0001'],
        default_security: 's2',
        confirmed: true,
        enroll: 'Put the controller in Add mode, then press keypad button 5 until a beep and the indicator flashes blue. Scan the DSK/QR on the back of the battery cover for S2.',
        exclude: 'Put the controller in Remove mode, then press keypad button 5 until a beep and the indicator flashes red.',
        reset: 'In the U-tec app (as Owner) tap Delete and Reset, then use the reset needle on the interior reset button ~3 seconds until one long and two short beeps.',
        quirk: 'Joins at S2 (also supports S0).',
      },
    ],
  },
  {
    manufacturer: 'Weiser / Baldwin',
    manufacturer_id: '0x0090',
    models: [
      {
        key: 'weiser-baldwin',
        name: 'Weiser / Baldwin (Home Connect)',
        match: [],
        default_security: 's0',
        confirmed: true,
        enroll: 'Put the controller in Add mode, then press interior button A once (shares the Kwikset stack).',
        exclude: 'Put the controller in Remove mode, then press button A once.',
        reset: 'Hold the Program button while reinserting the battery pack (~30s), then press Program once more.',
        quirk: 'Shares the Kwikset Z-Wave stack; 500-series joins at S0, Home Connect 620/918 at S2.',
      },
    ],
  },
  {
    manufacturer: 'Alfred',
    manufacturer_id: null,
    models: [
      {
        key: 'alfred-db',
        name: 'Alfred DB1 / DB2 (Z-Wave module)',
        match: [],
        default_security: 'auto',
        confirmed: false,
        enroll: 'On the lock enter Master Mode (** + Master passcode + #), open Network Settings (menu 88), and select the add/pair option while the controller is in Add mode. Scan the DSK/QR on the module for S2.',
        exclude: 'Master Mode > Network Settings (88) > the unpair/remove option, with the controller in Remove mode. Verify the exact digit against the lock manual.',
        reset: 'See the Alfred manual for the factory-reset gesture, then run Unpair to clear the controller.',
        quirk: 'Pairing is keypad-only (not via the Alfred app). Gesture details are unverified; check the manual.',
      },
    ],
  },
  {
    manufacturer: 'Other / not listed',
    manufacturer_id: null,
    models: [
      {
        key: 'generic',
        name: 'Generic Z-Wave deadbolt',
        match: [],
        default_security: 'auto',
        confirmed: false,
        enroll: "Put the controller in Add mode, then run this lock's inclusion sequence from its manual (usually a keypad code or an interior button). Leave security on Auto unless the manual says otherwise.",
        exclude: "Put the controller in Remove mode, then run the lock's exclusion sequence from its manual.",
        reset: "See the lock's manual for its factory-reset gesture, then run Unpair to clear it from the controller.",
        quirk: 'Fallback profile: procedures are generic. Follow the lock manufacturer manual.',
      },
    ],
  },
]);

// Flat list of every model, each tagged with its manufacturer for lookups.
const ALL_MODELS = CATALOG.flatMap((m) =>
  m.models.map((model) => Object.assign({ manufacturer: m.manufacturer, manufacturer_id: m.manufacturer_id }, model)));

const BY_KEY = new Map(ALL_MODELS.map((m) => [m.key, m]));
const BY_MATCH = new Map();
for (const m of ALL_MODELS) {
  for (const k of m.match) BY_MATCH.set(k, m);
}

/** The catalog grouped by manufacturer (for the Add Deadbolt pickers + API). */
function getCatalog() {
  return CATALOG;
}

/** A model profile by its catalog key, or null. */
function profileForKey(key) {
  return (key && BY_KEY.get(key)) || null;
}

/**
 * A model profile from a paired node's ids, or null. Accepts numbers or
 * pre-formatted hex4 strings. Used to auto-identify a paired lock.
 */
function profileForIds(mfgId, prodType, prodId) {
  if (mfgId == null || prodType == null || prodId == null) return null;
  const h = (n) => (typeof n === 'string' ? n : '0x' + Number(n).toString(16).padStart(4, '0'));
  return BY_MATCH.get(`${h(mfgId)}:${h(prodType)}:${h(prodId)}`) || null;
}

/** Clean model name for a set of ids, or null if unmapped. */
function modelNameForIds(mfgId, prodType, prodId) {
  const p = profileForIds(mfgId, prodType, prodId);
  return p ? p.name : null;
}

module.exports = { getCatalog, profileForKey, profileForIds, modelNameForIds, ALL_MODELS };
