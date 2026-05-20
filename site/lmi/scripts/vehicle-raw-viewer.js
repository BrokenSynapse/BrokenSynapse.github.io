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
    const mats = Array.isArray(child.material) ? child.material : [child.material].filter(Boolean);
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
    const mats = Array.isArray(child.material) ? child.material : [child.material].filter(Boolean);
    for (const mat of mats) {
      const name = String(mat.name || '').toLowerCase();
      mat.side = THREE.DoubleSide;
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

async function loadDaeScene(THREE, manager, item) {
  const loader = new rawViewerModules.ColladaLoader(manager);
  const collada = await loader.loadAsync(normalizeUrl(item.path));
  return collada.scene;
}

async function loadObjScene(THREE, manager, item) {
  const objLoader = new rawViewerModules.OBJLoader(manager);
  if (item.mtl) {
    const mtlLoader = new rawViewerModules.MTLLoader(manager);
    mtlLoader.setPath(basePath(item.mtl));
    const materials = await mtlLoader.loadAsync(normalizeUrl(item.mtl).split('/').pop());
    materials.preload();
    objLoader.setMaterials(materials);
  }
  objLoader.setPath(basePath(item.path));
  return objLoader.loadAsync(normalizeUrl(item.path).split('/').pop());
}

async function loadRawSource(THREE, manager, source) {
  const group = new THREE.Group();
  if (source?.preferred === 'dae' && Array.isArray(source.dae)) {
    for (const item of source.dae.slice(0, 4)) {
      group.add(await loadDaeScene(THREE, manager, item));
    }
    return group;
  }
  if (source?.obj) {
    group.add(await loadObjScene(THREE, manager, source.obj));
    return group;
  }
  throw new Error('No raw vehicle source available.');
}

async function mountRawVehicleViewer(mount, source, opts = {}) {
  const modules = await ensureRawViewerModules();
  const { THREE, OrbitControls, DDSLoader } = modules;
  mount.__rawVehicleViewer?.dispose?.();
  mount.innerHTML = '';
  mount.style.position = 'relative';
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 10000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotate = opts.autoRotate !== false;
  controls.autoRotateSpeed = 0.65;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x6f7f96, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(5, 8, 6);
  key.castShadow = true;
  scene.add(key);

  const manager = new THREE.LoadingManager();
  manager.addHandler(/\.dds$/i, new DDSLoader());
  manager.setURLModifier(url => normalizeUrl(url));
  let object;
  try {
    object = await loadRawSource(THREE, manager, source);
  } catch (err) {
    renderer.dispose();
    renderer.domElement.remove();
    throw err;
  }
  tuneMaterials(THREE, object);
  scene.add(object);
  fitCamera(THREE, camera, controls, object);

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

  function animate() {
    frame = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  const api = {
    dispose() {
      cancelAnimationFrame(frame);
      ro.disconnect();
      disposeObject(object);
      renderer.dispose();
      renderer.domElement.remove();
    }
  };
  mount.__rawVehicleViewer = api;
  return api;
}

window.LMIVehicleRawViewer = {
  load: mountRawVehicleViewer
};
