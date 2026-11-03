/* The CAD model in the 3D view: the nominal's measurement mesh at the current pose, colored by deviation (gray where
   not measured, light gray before a comparison has run). */
(function (App) {
  'use strict';
  const { state, on, emit } = App;
  const D = window.VBDeviation, A = window.VBAlign;

  /** World positions and colors: one vertex per measurement point (grid display), or three per measured triangle,
      colored by its centroid's deviation (triangle display). */
  function geometry(T, cad) {
    const pose = (cad.result && cad.result.transform) || cad.pose || A.IDENTITY, m = cad.measure;
    const limit = 3 * cad.toleranceMm, dev = cad.result && cad.result.deviations;
    const tri = m.display === 'triangles';
    const scan = A.apply(pose, tri ? m.triangles : m.points);
    const n = scan.length / 3, world = new Float32Array(scan.length), colors = new Float32Array(scan.length);
    for (let k = 0; k < n; k++) {
      const w = App.model3D.toWorld(scan[3 * k] / state.voxelMm, scan[3 * k + 1] / state.voxelMm, scan[3 * k + 2] / state.voxelMm);
      world[3 * k] = w[0]; world[3 * k + 1] = w[1]; world[3 * k + 2] = w[2];
      const c = dev ? D.deviationColor(dev[tri ? Math.floor(k / 3) : k], limit) : [0.8, 0.82, 0.85];
      colors[3 * k] = c[0]; colors[3 * k + 1] = c[1]; colors[3 * k + 2] = c[2];
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(world, 3));
    g.setAttribute('color', new T.BufferAttribute(colors, 3));
    if (!tri) g.setIndex(new T.BufferAttribute(m.faces, 1));
    g.computeVertexNormals();
    return g;
  }

  /** A click on the model: the measurement point nearest the hit (grid display) or the hit triangle's centroid. */
  function picked({ face, faceIndex, point }) {
    const ctx = App.model3D.ctx(), cad = state.cad;
    if (!ctx || !ctx.cad || !cad || !cad.measure) return;
    let index = faceIndex;
    if (cad.measure.display !== 'triangles') {
      const pos = ctx.cad.geometry.attributes.position;
      const d = (v) => (pos.getX(v) - point.x) ** 2 + (pos.getY(v) - point.y) ** 2 + (pos.getZ(v) - point.z) ** 2;
      index = [face.a, face.b, face.c].reduce((best, v) => (d(v) < d(best) ? v : best));
    }
    emit('cadProbe', { vertex: index });
  }

  function update() {
    const ctx = state.dims ? App.model3D.ctx() : null;
    if (!ctx) return;
    if (ctx.cad) { ctx.scene.remove(ctx.cad); ctx.cad.geometry.dispose(); ctx.cad = null; }
    const cad = state.cad;
    if (cad && cad.measure && cad.show3D !== false) {
      // The material color scales the lit vertex colors down so ambient plus key light does not wash them to white.
      ctx.cad = new ctx.T.Mesh(geometry(ctx.T, cad), new ctx.T.MeshLambertMaterial({ color: 0xc0c0c0, vertexColors: true, side: ctx.T.DoubleSide }));
      ctx.cad.renderOrder = 1;
      ctx.scene.add(ctx.cad);
    }
    if (ctx.mesh) ctx.mesh.visible = state.show.part && !ctx.cad; // the CAD model stands in for the see-through scan surface
    App.model3D.render();
  }

  on('cadPick', picked);
  on('cadChanged', update);
  on('modelChanged', update);
}(window.CTApp));
