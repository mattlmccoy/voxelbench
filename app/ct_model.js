/* The 3D view: the part's see-through surface, three planes showing where the slices are, and the real surfaces of
   voids and low-density patches. */
(function (App) {
  'use strict';
  const { state, $, on, emit } = App;
  const PLANE_COLOR = { XY: 0xffb454, XZ: 0x6ec3ff, YZ: 0xff8ad8 };
  const VOID_LAYERS = { pore: { color: 0xffb454, show: 'pores' }, crack: { color: 0xff5f56, show: 'cracks' }, clipped: { color: 0xb48cff, show: 'clipped' }, patch: { color: 0x35d0c0, show: 'patches' } };
  let three = null;

  // Scan axes to model axes: x stays, z points down so the model is upright, y runs into the screen.
  const toWorld = (x, y, z) => {
    const { nx, ny, nz } = state.dims;
    const v = state.voxelMm;
    return [(x - nx / 2) * v, -(z - nz / 2) * v, (y - ny / 2) * v];
  };

  function init() {
    const T = window.THREE;
    const box = $('modelBox');
    let renderer;
    try {
      renderer = new T.WebGLRenderer({ antialias: true });
    } catch (e) {
      $('modelEmpty').textContent = 'This browser could not start the 3D view.';
      return null;
    }
    renderer.setClearColor(0x000000);
    renderer.domElement.style.touchAction = 'pan-y';
    box.append(renderer.domElement);
    const scene = new T.Scene();
    scene.add(new T.AmbientLight(0xffffff, 0.55));
    const light = new T.DirectionalLight(0xffffff, 0.75);
    light.position.set(1, 2, 1.5);
    scene.add(light);
    const camera = new T.PerspectiveCamera(35, 1, 1, 2000);
    const planes = {};
    for (const p of Object.keys(PLANE_COLOR)) {
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(new Float32Array(12), 3));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      const mesh = new T.Mesh(g, new T.MeshBasicMaterial({ color: PLANE_COLOR[p], transparent: true, opacity: 0.28, side: T.DoubleSide, depthWrite: false }));
      const edge = new T.LineLoop(g, new T.LineBasicMaterial({ color: PLANE_COLOR[p] }));
      mesh.frustumCulled = false; edge.frustumCulled = false;
      scene.add(mesh, edge);
      planes[p] = { g, mesh, edge };
    }
    const orbit = { theta: 0.7, phi: 1.1, radius: 120 };
    const ctx = { T, renderer, scene, camera, planes, orbit, box, mesh: null, voids: {} };
    attachOrbit(ctx);
    new ResizeObserver(() => size(ctx)).observe(box);
    size(ctx);
    return ctx;
  }

  function size(ctx) {
    const { width, height } = ctx.box.getBoundingClientRect();
    if (!width || !height) return;
    ctx.renderer.setPixelRatio(window.devicePixelRatio || 1);
    ctx.renderer.setSize(width, height);
    ctx.camera.aspect = width / height;
    ctx.camera.updateProjectionMatrix();
    render(ctx);
  }

  function render(ctx) {
    const { orbit, camera, renderer, scene } = ctx;
    camera.position.set(orbit.radius * Math.sin(orbit.phi) * Math.sin(orbit.theta), orbit.radius * Math.cos(orbit.phi), orbit.radius * Math.sin(orbit.phi) * Math.cos(orbit.theta));
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  }

  function attachOrbit(ctx) {
    const el = ctx.renderer.domElement;
    let drag = null;
    el.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, moved: false }; try { el.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ } });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) > 3) drag.moved = true;
      if (!drag.moved) return;
      ctx.orbit.theta -= dx * 0.008;
      ctx.orbit.phi = Math.min(3.05, Math.max(0.1, ctx.orbit.phi - dy * 0.008));
      drag.x = e.clientX; drag.y = e.clientY;
      render(ctx);
    });
    el.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved) {
        if (state.main === '3D') pick(ctx, e);
        else App.setMain('3D');
      }
      drag = null;
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      ctx.orbit.radius = Math.min(600, Math.max(15, ctx.orbit.radius * Math.exp(e.deltaY * 0.002)));
      render(ctx);
    }, { passive: false });
  }

  // Clicking the model moves all three planes to that spot; clicking the CAD model also probes its deviation there.
  function pick(ctx, e) {
    if (!ctx.mesh && !ctx.cad) return;
    const rect = ctx.renderer.domElement.getBoundingClientRect();
    const ray = new ctx.T.Raycaster();
    ray.setFromCamera(new ctx.T.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), ctx.camera);
    const cadHit = ctx.cad && ctx.cad.visible ? ray.intersectObject(ctx.cad)[0] : null;
    if (cadHit) emit('cadPick', { face: cadHit.face, faceIndex: cadHit.faceIndex, point: cadHit.point });
    const hit = cadHit || (ctx.mesh ? ray.intersectObject(ctx.mesh)[0] : null);
    if (!hit) return;
    const { nx, ny, nz } = state.dims;
    const v = state.voxelMm;
    const clamp = (a, n) => Math.min(n - 1, Math.max(0, Math.round(a)));
    emit('jump', { x: clamp(hit.point.x / v + nx / 2, nx), y: clamp(hit.point.z / v + ny / 2, ny), z: clamp(-hit.point.y / v + nz / 2, nz) });
  }

  function setMesh(ctx) {
    const { positions, indices } = state.model;
    const world = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
      const w = toWorld(positions[i] - 0.5, positions[i + 1] - 0.5, positions[i + 2] - 0.5);
      world[i] = w[0]; world[i + 1] = w[1]; world[i + 2] = w[2];
    }
    if (ctx.mesh) { ctx.scene.remove(ctx.mesh); ctx.mesh.geometry.dispose(); }
    const g = new ctx.T.BufferGeometry();
    g.setAttribute('position', new ctx.T.BufferAttribute(world, 3));
    g.setIndex(new ctx.T.BufferAttribute(indices, 1));
    g.computeVertexNormals();
    ctx.mesh = new ctx.T.Mesh(g, new ctx.T.MeshStandardMaterial({ color: 0xaab4bf, roughness: 0.75, metalness: 0, transparent: true, opacity: 0.2, side: ctx.T.DoubleSide, depthWrite: false }));
    ctx.mesh.renderOrder = 2;
    ctx.scene.add(ctx.mesh);
    const { nx, ny, nz } = state.dims;
    ctx.orbit.radius = 1.25 * Math.hypot(nx, ny, nz) * state.voxelMm;
    $('modelEmpty').hidden = true;
    setPlanes(ctx); setLayers(ctx);
  }

  function setPlanes(ctx) {
    const { nx, ny, nz } = state.dims;
    const { x, y, z } = state.cursor;
    const corners = {
      XY: [[0, 0, z], [nx, 0, z], [nx, ny, z], [0, ny, z]],
      XZ: [[0, y, 0], [nx, y, 0], [nx, y, nz], [0, y, nz]],
      YZ: [[x, 0, 0], [x, ny, 0], [x, ny, nz], [x, 0, nz]],
    };
    for (const p of Object.keys(corners)) {
      const a = ctx.planes[p].g.attributes.position;
      corners[p].forEach((c, i) => { const w = toWorld(...c); a.setXYZ(i, w[0], w[1], w[2]); });
      a.needsUpdate = true;
    }
    render(ctx);
  }

  function setVoids(ctx) {
    for (const mesh of Object.values(ctx.voids)) { ctx.scene.remove(mesh); mesh.geometry.dispose(); }
    ctx.voids = {};
    if (!state.voidMeshes) { $('modelState').textContent = ''; setLayers(ctx); return; }
    let triangles = 0;
    for (const [key, data] of Object.entries(state.voidMeshes.meshes)) {
      const { positions, indices } = data;
      if (!indices.length) continue;
      const world = new Float32Array(positions.length);
      for (let i = 0; i < positions.length; i += 3) {
        const w = toWorld(positions[i], positions[i + 1], positions[i + 2]);
        world[i] = w[0]; world[i + 1] = w[1]; world[i + 2] = w[2];
      }
      const g = new ctx.T.BufferGeometry();
      g.setAttribute('position', new ctx.T.BufferAttribute(world, 3));
      g.setIndex(new ctx.T.BufferAttribute(indices, 1));
      g.computeVertexNormals();
      const mesh = new ctx.T.Mesh(g, new ctx.T.MeshStandardMaterial({ color: VOID_LAYERS[key].color, roughness: 0.6, metalness: 0, side: ctx.T.DoubleSide }));
      ctx.scene.add(mesh);
      ctx.voids[key] = mesh;
      triangles += indices.length / 3;
    }
    $('modelState').textContent = `${(triangles / 1e6).toFixed(1)} M triangles, ${(state.voidMeshes.cellMm * 1000).toFixed(0)} µm cells`;
    setLayers(ctx);
  }

  function setLayers(ctx) {
    if (ctx.mesh) ctx.mesh.visible = state.show.part && !ctx.cad;
    for (const [key, mesh] of Object.entries(ctx.voids)) mesh.visible = state.show[VOID_LAYERS[key].show];
    for (const p of Object.values(ctx.planes)) { p.mesh.visible = state.show.planes; p.edge.visible = state.show.planes; }
    render(ctx);
  }

  // ---------- review-sheet renders (match ct_pipeline/sample_render.py) ----------
  // view: above, toward +x and toward +scan y (world Z is scan y), as in ct_pipeline/sample_render.py
  const SHEET_3D = { width: 2000, height: 1100, fov: 30, view: [1, 1, 1], planeColor: { XY: '#f28e00', XZ: '#1f77d4' }, planeMarginMm: 1.5, triadMm: 8,
    sizeColors: ['#c2185b', '#3b1c6e'], sizeOpacity: [0.5, 0.32], markerEdgesMm: [0.5, 1, 2], markerColors: ['#6b7480', '#f0a020', '#e4572e'], markerPx: [6, 11, 16], markerOpacity: [0.6, 0.95, 0.95] };

  function worldGeometry(T, positions, indices, offset) {
    const world = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
      const w = toWorld(positions[i] - offset, positions[i + 1] - offset, positions[i + 2] - offset);
      world[i] = w[0]; world[i + 1] = w[1]; world[i + 2] = w[2];
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(world, 3));
    g.setIndex(new T.BufferAttribute(indices, 1));
    g.computeVertexNormals();
    return g;
  }

  function dotTexture(T) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.beginPath(); g.arc(32, 32, 30, 0, 2 * Math.PI); g.fillStyle = '#fff'; g.fill();
    return new T.CanvasTexture(c);
  }

  /** Two renders for the review sheet: the shell with section planes, and the shell with pores. Returns 2D canvases. */
  function sheetRenders(sheet) {
    const T = window.THREE, S3 = SHEET_3D;
    const renderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1); renderer.setSize(S3.width, S3.height, false); renderer.setClearColor(0xffffff, 1);
    const partGeo = worldGeometry(T, state.model.positions, state.model.indices, 0.5);
    const box = new T.Box3().setFromBufferAttribute(partGeo.attributes.position);
    const center = box.getCenter(new T.Vector3()), radius = box.getSize(new T.Vector3()).length() / 2;
    const camera = new T.PerspectiveCamera(S3.fov, S3.width / S3.height, 0.1, 10000);
    const dir = new T.Vector3(...S3.view).normalize();
    camera.position.copy(center).addScaledVector(dir, (radius / Math.sin((S3.fov * Math.PI) / 360)) * 0.95);
    camera.up.set(0, 1, 0); camera.lookAt(center);
    const v = state.voxelMm, m = S3.planeMarginMm;
    const c = state.cursor;
    const zWorld = toWorld(0, 0, c.z)[1], yWorld = toWorld(0, c.y, 0)[2];
    const planes = {
      XY: [[box.min.x - m, zWorld, box.min.z - m], [box.max.x + m, zWorld, box.min.z - m], [box.max.x + m, zWorld, box.max.z + m], [box.min.x - m, zWorld, box.max.z + m]],
      XZ: [[box.min.x - m, box.min.y - m, yWorld], [box.max.x + m, box.min.y - m, yWorld], [box.max.x + m, box.max.y + m, yWorld], [box.min.x - m, box.max.y + m, yWorld]],
    };
    const origin = new T.Vector3(box.min.x - 4, box.max.y + 2, box.min.z - 4);
    const axesDirs = [['x', new T.Vector3(1, 0, 0), '#c81e1e'], ['y', new T.Vector3(0, 0, 1), '#2e8b57'], ['z', new T.Vector3(0, -1, 0), '#1f4fd4']];
    const toPx = (p) => { const q = new T.Vector3(...p).project(camera); return [(q.x + 1) / 2 * S3.width, (1 - q.y) / 2 * S3.height]; };

    const base = () => {
      const scene = new T.Scene();
      scene.add(new T.AmbientLight(0xffffff, 0.6));
      const light = new T.DirectionalLight(0xffffff, 0.7);
      light.position.copy(camera.position);
      scene.add(light);
      return scene;
    };
    const fillPlanes = (scene) => {
      for (const [p, corners] of Object.entries(planes)) {
        const g = new T.BufferGeometry();
        g.setAttribute('position', new T.BufferAttribute(Float32Array.from(corners.flat()), 3));
        g.setIndex([0, 1, 2, 0, 2, 3]);
        scene.add(new T.Mesh(g, new T.MeshBasicMaterial({ color: S3.planeColor[p], transparent: true, opacity: 0.22, side: T.DoubleSide, depthWrite: false })));
      }
    };
    const shell = (opacity) => new T.Mesh(partGeo, new T.MeshStandardMaterial({ color: 0xb9c0c8, roughness: 0.6, metalness: 0, transparent: true, opacity, side: T.DoubleSide, depthWrite: false }));
    const finish = (scene) => {
      renderer.render(scene, camera);
      const out = document.createElement('canvas');
      out.width = S3.width; out.height = S3.height;
      const g = out.getContext('2d');
      g.drawImage(renderer.domElement, 0, 0);
      return out;
    };
    // Plane outlines, axis arrows and labels are drawn in 2D after rendering: WebGL lines are 1 px wide.
    const labels = (canvas) => {
      const g = canvas.getContext('2d');
      const label = (txt, [x, y], color, size, align = 'left') => {
        g.font = `bold ${size}px Arial, Helvetica, sans-serif`; g.textAlign = align; g.fillStyle = color; g.fillText(txt, x, y);
      };
      for (const [p, corners] of Object.entries(planes)) {
        const px = corners.map(toPx);
        g.strokeStyle = S3.planeColor[p]; g.lineWidth = 3;
        g.beginPath(); px.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.stroke();
      }
      // each plane label sits below the plane's lowest corner on screen: XY to its left, XZ to its right
      const lowest = (corners) => corners.map(toPx).reduce((a, b) => (b[1] > a[1] ? b : a));
      const [xyX, xyY] = lowest(planes.XY), [xzX, xzY] = lowest(planes.XZ);
      label(`XY, z = ${(c.z * v).toFixed(2)} mm`, [xyX - 12, xyY + 50], S3.planeColor.XY, 46, 'right');
      label(`XZ, y = ${(c.y * v).toFixed(2)} mm`, [xzX + 12, xzY + 50], S3.planeColor.XZ, 46);
      const o = toPx(origin.toArray());
      for (const [name, d, color] of axesDirs) {
        const [tx, ty] = toPx(origin.clone().addScaledVector(d, S3.triadMm).toArray());
        const a = Math.atan2(ty - o[1], tx - o[0]), head = 26;
        g.strokeStyle = color; g.fillStyle = color; g.lineWidth = 7;
        g.beginPath(); g.moveTo(o[0], o[1]); g.lineTo(tx - head * 0.7 * Math.cos(a), ty - head * 0.7 * Math.sin(a)); g.stroke();
        g.beginPath(); g.moveTo(tx, ty);
        g.lineTo(tx - head * Math.cos(a - 0.4), ty - head * Math.sin(a - 0.4)); g.lineTo(tx - head * Math.cos(a + 0.4), ty - head * Math.sin(a + 0.4)); g.fill();
        const [lx, ly] = toPx(origin.clone().addScaledVector(d, S3.triadMm * 1.35).toArray());
        label(name, [lx, ly + 20], color, 56, 'center');
      }
      label(`${S3.triadMm} mm`, [o[0], o[1] - 30], '#000', 40, 'center');
    };

    // (a) shell and section planes
    let scene = base();
    scene.add(shell(0.35));
    fillPlanes(scene);
    const solid = finish(scene);
    labels(solid);

    // silhouette of the shell, drawn on (b)
    scene = new T.Scene();
    scene.add(new T.Mesh(partGeo, new T.MeshBasicMaterial({ color: 0x000000 })));
    const mask = finish(scene).getContext('2d').getImageData(0, 0, S3.width, S3.height).data;

    // (b) shell, large-pore surfaces, centroid markers for the rest
    scene = base();
    scene.add(shell(0.15));
    sheet.surfaces.forEach((surf, k) => {
      if (!surf.indices.length) return;
      scene.add(new T.Mesh(worldGeometry(T, surf.positions, surf.indices, 0), new T.MeshStandardMaterial({ color: S3.sizeColors[k], roughness: 0.6, metalness: 0, transparent: true, opacity: S3.sizeOpacity[k], side: T.DoubleSide, depthWrite: false })));
    });
    const tex = dotTexture(T);
    const kept = state.pores.filter((p) => !state.rejected.has(p.id) && p.diameter_mm < S3.markerEdgesMm[2]);
    S3.markerColors.forEach((color, k) => {
      const lo = k === 0 ? 0 : S3.markerEdgesMm[k - 1], hi = S3.markerEdgesMm[k];
      const list = kept.filter((p) => p.diameter_mm >= lo && p.diameter_mm < hi);
      const pos = new Float32Array(list.length * 3);
      list.forEach((p, i) => pos.set(toWorld(p.x, p.y, p.z), i * 3));
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(pos, 3));
      scene.add(new T.Points(g, new T.PointsMaterial({ color, size: S3.markerPx[k], sizeAttenuation: false, map: tex, alphaTest: 0.5, transparent: true, opacity: S3.markerOpacity[k] })));
    });
    const pores = finish(scene);
    const g2 = pores.getContext('2d');
    const img = g2.getImageData(0, 0, S3.width, S3.height);
    const dark = (i) => mask[i] < 128;
    for (let y = 1; y < S3.height - 1; y++) {
      for (let x = 1; x < S3.width - 1; x++) {
        const i = (y * S3.width + x) * 4;
        if (dark(i) && (!dark(i - 4) || !dark(i + 4) || !dark(i - 4 * S3.width) || !dark(i + 4 * S3.width))) {
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const j = i + 4 * (dy * S3.width + dx); img.data[j] = 74; img.data[j + 1] = 82; img.data[j + 2] = 92; }
        }
      }
    }
    g2.putImageData(img, 0, 0);
    labels(pores);
    renderer.dispose(); partGeo.dispose();
    return { solid, pores, markerEdgesMm: S3.markerEdgesMm, markerColors: S3.markerColors, sizeColors: S3.sizeColors, sizeOpacity: S3.sizeOpacity };
  }
  App.sheetRenders = sheetRenders;
  /** For other 3D layers (the CAD model): the view, started on first use, and the scan-to-view mapping. */
  App.model3D = {
    ctx: () => { if (!three && state.dims && window.THREE) three = init(); return three; },
    toWorld,
    render: () => { if (three) render(three); },
  };

  const withCtx = (fn) => () => {
    if (!state.dims || !window.THREE) return;
    if (!three) three = init();
    if (three) fn(three);
  };
  on('modelChanged', withCtx((c) => { size(c); setMesh(c); }));
  on('cursorMoved', () => { if (three && state.model) setPlanes(three); });
  on('voidMeshesChanged', withCtx(setVoids));
  on('layersChanged', () => { if (three && state.model) setLayers(three); });
}(window.CTApp));
