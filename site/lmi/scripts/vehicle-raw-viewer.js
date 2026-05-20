let rawViewerModules = null;

async function ensureRawViewerModules() {
  if (rawViewerModules) return rawViewerModules;
  const [
    THREE,
    { OrbitControls },
    { DDSLoader },
    { MTLLoader },
    { OBJLoader },
    { ColladaLoader }
  ] = await Promise.all([
    import('https://esm.sh/three@0.160.1'),
    import('https://esm.sh/three@0.160.1/examples/jsm/controls/OrbitControls.js'),
    import('https://esm.sh/three@0.160.1/examples/jsm/loaders/DDSLoader.js'),
    import('https://esm.sh/three@0.160.1/examples/jsm/loaders/MTLLoader.js'),
    import('https://esm.sh/three@0.160.1/examples/jsm/loaders/OBJLoader.js'),
    import('https://esm.sh/three@0.160.1/examples/jsm/loaders/ColladaLoader.js')
  ]);
  rawViewerModules = { THREE, OrbitControls, DDSLoader, MTLLoader, OBJLoader, ColladaLoader };
  return rawViewerModules;
}

function disposeObject(obj) {
  obj.traverse(child => {
    if (child.geometry) child.geometry.dispose();
    const mats = (Array.isArray(child.material) ? child.material : [child.material]).filter(Boolean);
    for (const mat of mats) {
      for (const value of Object.values(mat)) {
        if (value && value.isTexture) value.dispose();
      }
      mat.dispose?.();
    }
  });
}

function normalizeUrl(url) {
  return String(url || '').replace(/\\/g, '/');
}

function basePath(url) {
  const clean = normalizeUrl(url).split('?')[0];
  return clean.slice(0, clean.lastIndexOf('/') + 1);
}

function fitCamera(THREE, camera, controls, object, padding = 1.35) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const fov = camera.fov * Math.PI / 180;
  const distance = Math.abs(maxDim / Math.sin(fov / 2)) * 0.48 * padding;
  camera.position.set(center.x + distance * 0.55, center.y + distance * 0.28, center.z + distance * 0.82);
  camera.near = Math.max(0.01, distance / 100);
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

function tuneMaterials(THREE, object) {
  object.traverse(child => {
    if (!child.isMesh) return;
    child.castShadow = true;
    child.receiveShadow = true;
    const fallback = new THREE.MeshStandardMaterial({ color: 0xd8dde2, roughness: 0.62, metalness: 0.05 });
    if (Array.isArray(child.material)) {
      child.material = child.material.map(mat => mat || fallback);
    } else if (!child.material) {
      child.material = fallback;
    }
    const mats = (Array.isArray(child.material) ? child.material : [child.material]).filter(Boolean);
    for (const mat of mats) {
      const name = String(mat.name || '').toLowerCase();
      mat.side = THREE.DoubleSide;
      if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace;
      if (/glass|window|windscreen|windshield/.test(name)) {
        mat.transparent = true;
        mat.opacity = Math.min(mat.opacity || 0.45, 0.42);
        mat.depthWrite = false;
      }
      if (/chrome|metal|rim|wheel|exhaust|pipe|hub/.test(name)) {
        mat.metalness = Math.max(mat.metalness || 0, 0.7);
        mat.roughness = Math.min(mat.roughness ?? 0.35, 0.28);
      }
      if (/tyre|tire|rubber/.test(name)) {
        mat.roughness = Math.max(mat.roughness ?? 0.7, 0.78);
      }
      mat.needsUpdate = true;
    }
  });
}

function emitProgress(opts, text) {
  if (typeof opts.onProgress === 'function') opts.onProgress(text);
}

function emitFirstObject(opts) {
  if (typeof opts.onFirstObject === 'function') opts.onFirstObject();
}

async function loadDaeScene(THREE, manager, item) {
  const loader = new rawViewerModules.ColladaLoader(manager);
  const collada = await loader.loadAsync(normalizeUrl(item.path));
  return collada.scene;
}

async function loadObjScene(THREE, manager, item, opts) {
  const objLoader = new rawViewerModules.OBJLoader(manager);
  if (item.mtl) {
    emitProgress(opts, 'Loading material map...');
    const mtlLoader = new rawViewerModules.MTLLoader(manager);
    mtlLoader.setPath(basePath(item.mtl));
    const materials = await mtlLoader.loadAsync(normalizeUrl(item.mtl).split('/').pop());
    materials.preload();
    objLoader.setMaterials(materials);
  }
  emitProgress(opts, 'Streaming KN5 mesh...');
  objLoader.setPath(basePath(item.path));
  return objLoader.loadAsync(normalizeUrl(item.path).split('/').pop());
}

async function streamRawSource(THREE, manager, source, root, controls, camera, state, opts) {
  if (source?.preferred === 'dae' && Array.isArray(source.dae) && source.dae.length) {
    const items = source.dae.slice(0, 4);
    for (let i = 0; i < items.length; i++) {
      if (state.disposed) return;
      emitProgress(opts, `Loading DAE ${i + 1}/${items.length}...`);
      const scene = await loadDaeScene(THREE, manager, items[i]);
      if (state.disposed) {
        disposeObject(scene);
        return;
      }
      tuneMaterials(THREE, scene);
      root.add(scene);
      emitFirstObject(opts);
      fitCamera(THREE, camera, controls, root);
      emitProgress(opts, i === items.length - 1 ? 'Raw DAE ready.' : `Showing DAE ${i + 1}/${items.length}...`);
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return;
  }
  if (source?.obj) {
    const object = await loadObjScene(THREE, manager, source.obj, opts);
    if (state.disposed) {
      disposeObject(object);
      return;
    }
    tuneMaterials(THREE, object);
    root.add(object);
    emitFirstObject(opts);
    fitCamera(THREE, camera, controls, root);
    emitProgress(opts, 'Raw KN5 source ready.');
    return;
  }
  throw new Error('No raw vehicle source available.');
}

async function mountRawVehicleViewer(mount, source, opts = {}) {
  const modules = await ensureRawViewerModules();
  const { THREE, OrbitControls, DDSLoader } = modules;
  mount.__rawVehicleViewer?.dispose?.();
  mount.innerHTML = '';
  mount.style.position = 'relative';

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, opts.pixelRatio || 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 10000);
  const controls = new OrbitControls(camera, renderer.domElement);
  const root = new THREE.Group();
  const state = { disposed: false, visible: true };
  controls.enableDamping = true;
  controls.autoRotate = opts.autoRotate !== false;
  controls.autoRotateSpeed = 0.65;
  camera.position.set(4, 2, 6);
  controls.target.set(0, 0, 0);
  scene.add(root);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x6f7f96, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(5, 8, 6);
  key.castShadow = true;
  scene.add(key);

  let frame = 0;
  const resize = () => {
    const rect = mount.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(mount);
  resize();

  const io = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    state.visible = entries.some(entry => entry.isIntersecting);
  }) : null;
  io?.observe(mount);

  function animate() {
    if (state.disposed) return;
    frame = requestAnimationFrame(animate);
    if (!state.visible) return;
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  const api = {
    dispose() {
      state.disposed = true;
      cancelAnimationFrame(frame);
      ro.disconnect();
      io?.disconnect();
      disposeObject(root);
      renderer.dispose();
      renderer.domElement.remove();
    }
  };
  mount.__rawVehicleViewer = api;

  const manager = new THREE.LoadingManager();
  manager.addHandler(/\.dds$/i, new DDSLoader());
  manager.setURLModifier(url => normalizeUrl(url));
  emitProgress(opts, 'Preparing hardware viewer...');
  try {
    await streamRawSource(THREE, manager, source, root, controls, camera, state, opts);
  } catch (err) {
    if (!state.disposed) api.dispose();
    throw err;
  }
  return api;
}

window.LMIVehicleRawViewer = {
  load: mountRawVehicleViewer
};
