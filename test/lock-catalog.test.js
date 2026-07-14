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

test('getCatalog groups models under manufacturers for the picker', () => {
  const cat = catalog.getCatalog();
  assert.ok(Array.isArray(cat) && cat.length >= 4);
  for (const mfr of cat) {
    assert.ok(mfr.manufacturer && Array.isArray(mfr.models) && mfr.models.length);
  }
  assert.ok(cat.some((m) => m.manufacturer === 'Schlage'));
  assert.ok(cat.some((m) => m.manufacturer === 'Yale'));
});
