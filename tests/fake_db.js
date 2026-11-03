'use strict';
// Test stand-in for the artifact database: same call shapes, and every record it hands back is deep-frozen,
// as the real database's are.
const freeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(freeze); Object.freeze(o); } return o; };
const copy = (o) => JSON.parse(JSON.stringify(o));

function makeFakeDb() {
  const collections = new Map(), docs = new Map(), watchers = new Map();
  const col = (name) => { if (!collections.has(name)) collections.set(name, new Map()); return collections.get(name); };
  const notify = (name) => {
    const snap = { docs: [...col(name)].map(([id, d]) => ({ id, data: () => freeze(copy(d)) })) };
    for (const fn of watchers.get(name) || []) fn(snap);
  };
  const docRef = (p) => ({
    get: async () => ({ exists: docs.has(p), data: () => freeze(copy(docs.get(p))) }),
    set: async (d) => { docs.set(p, copy(d)); },
    delete: async () => { docs.delete(p); },
    collection: (c) => ({ doc: (id) => docRef(`${p}/${c}/${id}`) }),
  });
  return {
    collection: (name) => ({
      onSnapshot(fn) { (watchers.get(name) || watchers.set(name, []).get(name)).push(fn); notify(name); return () => {}; },
      doc: (id) => ({
        set: async (d) => { col(name).set(id, copy(d)); notify(name); },
        delete: async () => { col(name).delete(id); notify(name); },
      }),
    }),
    doc: docRef,
    _docs: docs,
  };
}

module.exports = { makeFakeDb };
