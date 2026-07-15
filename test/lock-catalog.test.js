'use strict';

// Guards the deadbolt model catalog: every model must carry the three
// per-model gestures + a default security mode (the Add Deadbolt UI and the
// locks-table guidance depend on them), the known ids must resolve to the
// exact display names the identity layer expects, and a generic fallback must
// always exist so Add Deadbolt works for an unlisted model.

const test = require('node:test');
const assert = require('node:assert');
const catalog = require('../src/drivers/lock-catalog');

test('every model has enroll/exclude/reset gestures and a valid default security', () => {
  const modes = new Set(['auto', 's2', 's0']);
  assert.ok(catalog.ALL_MODELS.length >= 5);
  for (const m of catalog.ALL_MODELS) {
    assert.ok(m.key && typeof m.key === 'string', `model needs a key: ${JSON.stringify(m)}`);
    assert.ok(m.name, `model ${m.key} needs a name`);
    assert.ok(m.enroll && m.exclude && m.reset, `model ${m.key} needs all three gestures`);
    assert.ok(modes.has(m.default_security), `model ${m.key} default_security invalid: ${m.default_security}`);
    assert.equal(typeof m.confirmed, 'boolean');
  }
});

test('known ids resolve to the clean display names the identity layer uses', () => {
  assert.equal(catalog.modelNameForIds(0x003b, 0x0001, 0x0469), 'Schlage BE469ZP Touchscreen Deadbolt');
  assert.equal(catalog.modelNameForIds(0x0129, 0x8002, 0x1600), 'Yale Assure Deadbolt (ZW2)');
  assert.equal(catalog.modelNameForIds(0x0452, 0x0004, 0x0001), 'Ultraloq U-Bolt Pro Z-Wave');
  assert.equal(catalog.modelNameForIds(0x0abc, 1, 2), null, 'unmapped -> null (driver falls back to db label)');
  assert.equal(catalog.modelNameForIds(null, null, null), null);
});

test('profileForKey returns the model, and a generic fallback always exists', () => {
  const yale = catalog.profileForKey('yale-assure-zw2');
  assert.equal(yale.default_security, 's0');
  assert.match(yale.enroll, /Master PIN/);
  const generic = catalog.profileForKey('generic');
  assert.ok(generic, 'a generic profile must exist for unlisted locks');
  assert.equal(generic.default_security, 'auto');
  assert.equal(catalog.profileForKey('does-not-exist'), null);
});

test('auto_relock is a well-formed parameter block or null with a note', () => {
  for (const m of catalog.ALL_MODELS) {
    assert.ok('auto_relock' in m, `model ${m.key} must declare auto_relock (or null)`);
    if (m.auto_relock) {
      assert.equal(typeof m.auto_relock.parameter, 'number', `model ${m.key} parameter`);
      assert.ok(m.auto_relock.size >= 1, `model ${m.key} size`);
      assert.notEqual(m.auto_relock.on, m.auto_relock.off, `model ${m.key} on/off must differ`);
    } else {
      assert.ok(m.auto_relock_note, `model ${m.key} without a parameter needs a note for the operator`);
    }
  }
  // The two families with authoritative parameters: Schlage 15, Yale 2.
  assert.equal(catalog.profileForKey('schlage-be469zp').auto_relock.parameter, 15);
  assert.equal(catalog.profileForKey('schlage-be469zp').auto_relock.off, 0);
  assert.equal(catalog.profileForKey('yale-assure-zw2').auto_relock.parameter, 2);
  assert.equal(catalog.profileForKey('generic').auto_relock, null);
});

test('user_codes is a well-formed capability block or null with a note', () => {
  for (const m of catalog.ALL_MODELS) {
    assert.ok('user_codes' in m, `model ${m.key} must declare user_codes (or null)`);
    if (m.user_codes) {
      assert.ok(m.user_codes.slots > 0, `model ${m.key} slots`);
      assert.ok(m.user_codes.min_length <= m.user_codes.max_length, `model ${m.key} length range`);
      assert.equal(typeof m.user_codes.fixed_length, 'boolean', `model ${m.key} fixed_length`);
    } else {
      assert.ok(m.user_codes_note, `model ${m.key} without user_codes needs an operator note`);
    }
  }
  const schlage = catalog.profileForKey('schlage-be469zp').user_codes;
  assert.equal(schlage.slots, 30);
  assert.equal(schlage.length_parameter, 16, 'Schlage code length lives in parameter 16');
  assert.equal(schlage.fixed_length, true);
  assert.equal(catalog.profileForKey('generic').user_codes, null);
});

test('rf_verify optimistic is set (with a note) on exactly the two Schlage models', () => {
  const flagged = catalog.ALL_MODELS.filter((m) => m.rf_verify != null);
  assert.deepEqual(flagged.map((m) => m.key).sort(), ['schlage-be469', 'schlage-be469zp']);
  for (const m of flagged) {
    assert.equal(m.rf_verify, 'optimistic', `model ${m.key} rf_verify value`);
    assert.ok(m.rf_verify_note, `model ${m.key} needs a note explaining the quirk`);
  }
});

test('getCatalog groups models under manufacturers for the picker', () => {
  const cat = catalog.getCatalog();
  assert.ok(Array.isArray(cat) && cat.length >= 4);
  for (const mfr of cat) {
    assert.ok(mfr.manufacturer && Array.isArray(mfr.models) && mfr.models.length);
  }
  assert.ok(cat.some((m) => m.manufacturer === 'Schlage'));
  assert.ok(cat.some((m) => m.manufacturer === 'Yale'));
});
