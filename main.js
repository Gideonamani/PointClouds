import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeBufferGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';
import GUI from 'three/addons/libs/lil-gui.module.min.js';

let scene, camera, renderer, controls, tiger, tigerGroup;
let originalVertices = [];
let stripeCoord = null; // per-point scalar 0..1 along body length
let colorArray = null;  // Float32Array for per-vertex colors
let startVertices = null; // for formation animation
let wobbleIntensity = 0.1; // scaled after load based on model size
let hoverPointLocal = null;
let hoverRadius = 0; // scaled after load

const clock = new THREE.Clock();
let formationStart = 0;
const formationDuration = 3000; // ms
let formationDone = false;
let helpersAdded = false;
let gridHelper = null;
let axesHelper = null;
let rotationAxisLine = null;
let baseMergedGeometry = null; // before orientation/alignment
let lastColorUpdate = 0;
const targetColorFPS = 45; // throttle color recomputation if needed
const STORAGE_KEY = 'pctiger.params.v1';
const GUI_STATE_KEY = 'pctiger.guiState.v1';
let loadedParamsKeys = new Set();

// Local axes + gizmo
let tigerAxesHelper = null;
let gizmoGroup = null;
let gizmoRings = { x: null, y: null, z: null };
let isDraggingGizmo = false;
let activeAxis = null; // 'x' | 'y' | 'z' | null
let dragStartInfo = null; // { axis: 'x', center: Vector3, axisWorld: Vector3, startVec: Vector3, startRot: {x,y,z} }
// Floor (optional grassy plane)
let floorMesh = null;
let grassMaterial = null;
// Base orientation (from params) used every frame, gait adds on top
let baseRot = { x: 0, y: 0, z: 0 }; // radians
// Materials/textures for GPU stripes
let cpuPointsMaterial = null;
let gpuStripesMaterial = null;
let paletteTexture = null;

// UI params
const params = {
    pointCount: 30000,
    pointSize: 0.01,
    color: '#ff8800',
    walkSpeed: 0, // set after camera init
    pauseWalk: false,
    rotationSpeed: 0.0, // rad/s applied to tiger (not group yaw)
    showGrid: true,
    showWorldAxes: true,
    explode: 0.0, // 0 formed .. 1 fully exploded
    showRotationAxis: true,
    showLocalAxes: true,
    showGizmo: true,
    floorHeight: -0.97,
    floorStyle: 'Grid', // 'Grid' | 'Grass'
    modelUp: '+Y',
    modelForward: '+X',
    // Stripes
    stripesEnabled: true,
    stripesGPU: false,
    stripesCount: 8,
    rippleSpeed: 0.6,     // cycles per second
    rippleAmplitude: 0.4, // 0..1 offset of stripe phase
    rippleWaves: 2,       // additional wave count across body
    stripeSoftness: 0.25, // 0 hard bands .. 1 very soft
    palette: 'Tiger',
    // Orientation manipulator (degrees)
    rotXDeg: 105,
    rotYDeg: -90,
    rotZDeg: -30,
    // Wobble boost
    wobbleIntensityMult: 2.0,
    wobbleRadiusMult: 1.2,
    wobbleNoiseSpeed: 1.6,
    wobbleSizeBoost: 2.5,
    // Simple gait
    gaitEnabled: true,
    gaitBobAmp: 0.03,
    gaitSwayAmp: 0.02,
    gaitPitchAmpDeg: 2.0,
    gaitFreq: 1.2,
    gaitHeadBobAmp: 0.02,
    gaitTailSwayAmp: 0.02,
    gaitFrontSplit: 0.55,
};

// Predefined color palettes
const palettes = {
    Tiger: ['#111111', '#ff8800', '#111111', '#ff8800'],
    Rainbow: ['#ff0000','#ffa500','#ffff00','#00ff00','#00bfff','#0000ff','#8a2be2'],
    Warm: ['#4b1d0e','#7a2f16','#b3431e','#f36f21','#ffc857'],
    Cool: ['#0b132b','#1c2541','#3a506b','#5bc0be','#cce2e1'],
};

const pose = { x: 0, y: 0, z: 0, yawDeg: 0 };

function init() {
    // Load saved GUI params before building scene/UI
    loadSavedParams();
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111111);

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 5;

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    const loader = new GLTFLoader();
    loader.load('tiger.glb', (gltf) => {
        console.log("Tiger model loaded successfully!");

        // Merge all mesh geometries into a single point cloud
        const geometries = [];
        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse((object) => {
            if (object.isMesh && object.geometry) {
                const geom = object.geometry.clone();
                // Bake mesh transforms into geometry
                geom.applyMatrix4(object.matrixWorld);
                // Drop unused attributes to save memory
                if (geom.getAttribute('normal')) geom.deleteAttribute('normal');
                if (geom.getAttribute('uv')) geom.deleteAttribute('uv');
                geometries.push(geom);
            }
        });

        if (geometries.length === 0) {
            console.warn('No mesh geometries found in GLTF.');
            return;
        }

        baseMergedGeometry = mergeBufferGeometries(geometries, false);
        // Apply orientation correction and align to datum
        const oriented = orientAndAlign(baseMergedGeometry);
        oriented.computeBoundingBox();
        const box = oriented.boundingBox;
        const size = new THREE.Vector3();
        box.getSize(size);

        const maxDim = Math.max(size.x, size.y, size.z);
        // Default visual scale (respect saved overrides)
        const recommendedSize = Math.max(maxDim * 0.0015, 0.0025);
        const recommendedCount = Math.min(60000, Math.max(8000, Math.floor((size.x * size.y + size.z * size.x + size.y * size.z) * 120)));
        if (!loadedParamsKeys.has('pointSize')) params.pointSize = recommendedSize;
        if (!loadedParamsKeys.has('pointCount')) params.pointCount = recommendedCount;

        cpuPointsMaterial = new THREE.PointsMaterial({
            color: new THREE.Color(params.color),
            size: params.pointSize,
            sizeAttenuation: true
        });

        // Build initial sampled point cloud for adjustable density
        const sampled = samplePointsFromGeometry(oriented, params.pointCount);
        tiger = new THREE.Points(sampled, cpuPointsMaterial);
        tigerGroup = new THREE.Group();
        tigerGroup.add(tiger);
        scene.add(tigerGroup);

        // Adjust camera to frame the model nicely
        const fov = camera.fov * (Math.PI / 180);
        const cameraZ = (maxDim / 2) / Math.tan(fov / 2) * 1.5; // padding factor
        camera.position.set(0, 0, cameraZ);
        camera.near = Math.max(cameraZ / 100, 0.01);
        camera.far = cameraZ * 100;
        camera.updateProjectionMatrix();

        if (controls) {
            controls.target.set(0, 0, 0);
            controls.update();
        }

        // Add ground grid and axes once sized
        if (!helpersAdded) {
            gridHelper = new THREE.GridHelper(maxDim * 2, 40, 0x444444, 0x222222);
            gridHelper.position.y = params.floorHeight || 0;
            scene.add(gridHelper);
            axesHelper = new THREE.AxesHelper(maxDim * 0.6);
            scene.add(axesHelper);
            helpersAdded = true;
        }
        if (gridHelper) gridHelper.visible = params.showGrid && params.floorStyle === 'Grid';
        if (axesHelper) {
            axesHelper.visible = params.showWorldAxes;
            axesHelper.position.y = params.floorHeight || 0;
        }

        // Create/update grassy floor (optional)
        createOrUpdateGrassFloor(Math.max(size.x, size.y, size.z) * 6);

        // Store original vertices (targets) for wobble/formation
        const posAttr = tiger.geometry.getAttribute('position');
        originalVertices = Array.from(posAttr.array);
        // Initialize stripes data + color attribute
        initStripesData();

        // Initialize formation: start far away, converge to original
        startVertices = new Float32Array(posAttr.array.length);
        const R = maxDim * 10; // "from infinity" radius
        for (let i = 0; i < startVertices.length; i += 3) {
            // random direction on unit sphere
            let x = Math.random() * 2 - 1;
            let y = Math.random() * 2 - 1;
            let z = Math.random() * 2 - 1;
            const len = Math.hypot(x, y, z) || 1;
            x /= len; y /= len; z /= len;
            const r = R * (0.8 + Math.random() * 0.4);
            startVertices[i] = x * r;
            startVertices[i + 1] = y * r;
            startVertices[i + 2] = z * r;
            // Set current positions to start positions
            posAttr.array[i] = startVertices[i];
            posAttr.array[i + 1] = startVertices[i + 1];
            posAttr.array[i + 2] = startVertices[i + 2];
        }
        posAttr.needsUpdate = true;
        formationStart = performance.now();
        formationDone = false;

        // Scale wobble and raycast threshold relative to model size
        wobbleIntensity = Math.max(maxDim * 0.004, params.pointSize * 0.75) * params.wobbleIntensityMult;
        hoverRadius = Math.max(maxDim * 0.06, params.pointSize * 6) * params.wobbleRadiusMult;

        // Init walk range and starting position based on camera distance
        walkRange = camera.position.z * 0.6; // stays in view
        params.walkSpeed = walkRange / 8; // cross ~8s by default
        // Place the tiger at the left bound before formation so there's no post-formation jump
        if (tigerGroup) {
            tigerGroup.position.x = -walkRange;
            tigerGroup.rotation.y = 0;
            walkDirection = 1;
            walkStarted = true;
        }

        // Build UI
        setupGUI(baseMergedGeometry);

        // Create rotation axis visualization
        createOrUpdateRotationAxisLine();

        // Create local axes helper attached to tiger
        if (tigerAxesHelper) {
            tiger.remove(tigerAxesHelper);
            tigerAxesHelper.geometry && tigerAxesHelper.geometry.dispose && tigerAxesHelper.geometry.dispose();
            tigerAxesHelper.material && tigerAxesHelper.material.dispose && tigerAxesHelper.material.dispose();
        }
        tigerAxesHelper = new THREE.AxesHelper(Math.max(size.x, size.y, size.z) * 0.6);
        tiger.add(tigerAxesHelper);
        tigerAxesHelper.visible = params.showLocalAxes;

        // Create rotation gizmo rings
        createOrUpdateGizmo(Math.max(size.x, size.y, size.z));

        // Apply initial orientation from params and floor height
        applyOrientationFromParams();
        if (gridHelper) gridHelper.position.y = params.floorHeight;

    }, undefined, (error) => {
        console.error("Error loading tiger model:", error);
    });

    window.addEventListener('resize', onWindowResize, false);
    document.addEventListener('mousemove', onDocumentMouseMove, false);
    document.addEventListener('mousedown', onDocumentMouseDown, false);
    document.addEventListener('mouseup', onDocumentMouseUp, false);
    const saveAll = () => { if (window._pctigerSaveHook) window._pctigerSaveHook(); else saveParams(); };
    window.addEventListener('beforeunload', saveAll, false);
    window.addEventListener('pagehide', saveAll, false);
    document.addEventListener('visibilitychange', () => { if (document.hidden) saveAll(); }, false);

    animate();
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    // keep shader point size scaling consistent across DPR changes
    if (tiger && tiger.material && tiger.material.uniforms && tiger.material.uniforms.uPixelRatio) {
        tiger.material.uniforms.uPixelRatio.value = window.devicePixelRatio || 1;
    }
}

// Walking motion across a range
let walkDirection = 1;
let walkRange = 0; // set after load via cameraZ or model size
let walkSpeed = 0; // units per second
let walkStarted = false; // start after formation
let isTurning = false;
let turnStart = 0;
let turnFrom = 0;
let turnDelta = 0;
const turnDuration = 1.5; // seconds
let gaitPhase = 0; // cycles advance with time when walking

function animate() {
    requestAnimationFrame(animate);

    const dt = clock.getDelta();
    const elapsed = clock.elapsedTime;

    if (tiger) {
        // Formation + explode control combined as an "effective explode factor"
        const posAttr = tiger.geometry.getAttribute('position');
        const arr = posAttr.array;
        let e = 1; // formation progress 0..1
        if (!formationDone && startVertices) {
            const t = Math.min(1, (performance.now() - formationStart) / formationDuration);
            e = 1 - Math.pow(1 - t, 3); // easeOutCubic
            if (t >= 1) formationDone = true;
        }
        const formationExplode = 1 - e; // 1 at start, 0 when formed
        const fEff = Math.max(formationExplode, params.explode);

        // Precompute gait offsets (head/tail) for this frame
        let headBobY = 0, tailSwayZ = 0;
        if (params.gaitEnabled) {
            headBobY = Math.sin(gaitPhase * Math.PI * 2) * params.gaitHeadBobAmp;
            tailSwayZ = Math.sin(gaitPhase * Math.PI * 2 + Math.PI * 0.5) * params.gaitTailSwayAmp;
        }

        // Update positions toward base (lerp of original and start), then apply gait offsets
        let updated = false;
        if (hoverPointLocal) {
            const hx = hoverPointLocal.x;
            const hy = hoverPointLocal.y;
            const hz = hoverPointLocal.z;
            const r2 = hoverRadius * hoverRadius;
            for (let i = 0; i < arr.length; i += 3) {
                const ox = originalVertices[i];
                const oy = originalVertices[i + 1];
                const oz = originalVertices[i + 2];
                const sx = startVertices ? startVertices[i] : ox;
                const sy = startVertices ? startVertices[i + 1] : oy;
                const sz = startVertices ? startVertices[i + 2] : oz;
                let bx = ox + (sx - ox) * fEff;
                let by = oy + (sy - oy) * fEff;
                let bz = oz + (sz - oz) * fEff;
                // Apply head/tail offsets based on stripe (x) coordinate
                if (params.gaitEnabled && stripeCoord) {
                    const sIdx = (i / 3) | 0;
                    const s = stripeCoord[sIdx];
                    const headW = Math.max(0, (s - params.gaitFrontSplit)) / Math.max(1e-6, 1 - params.gaitFrontSplit);
                    const tailW = 1 - headW;
                    by += headBobY * headW;
                    bz += tailSwayZ * tailW;
                }
                const dx = bx - hx;
                const dy = by - hy;
                const dz = bz - hz;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 < r2) {
                    const d = Math.sqrt(Math.max(d2, 1e-6));
                    const falloff = 1 - d / hoverRadius; // 0..1
                    const amp = wobbleIntensity * falloff * falloff;
                    // Coherent wobble using position-based hash and time
                    const seed = ox * 12.9898 + oy * 78.233 + oz * 37.719;
                    const tphase = performance.now() * 0.001 * params.wobbleNoiseSpeed * Math.PI * 2.0;
                    const n = Math.sin(seed + tphase); // -1..1
                    // Stable pseudo-random direction from seed
                    let vx = Math.sin(seed * 1.3);
                    let vy = Math.sin(seed * 1.7 + 1.0);
                    let vz = Math.sin(seed * 1.9 + 2.0);
                    const vlen = Math.hypot(vx, vy, vz) || 1;
                    vx /= vlen; vy /= vlen; vz /= vlen;
                    arr[i] = bx + vx * amp * n;
                    arr[i + 1] = by + vy * amp * n;
                    arr[i + 2] = bz + vz * amp * n;
                } else {
                    // Relax toward base
                    arr[i] += (bx - arr[i]) * Math.min(1, dt * 10);
                    arr[i + 1] += (by - arr[i + 1]) * Math.min(1, dt * 10);
                    arr[i + 2] += (bz - arr[i + 2]) * Math.min(1, dt * 10);
                }
            }
            updated = true;
        } else {
            for (let i = 0; i < arr.length; i += 3) {
                const ox = originalVertices[i];
                const oy = originalVertices[i + 1];
                const oz = originalVertices[i + 2];
                const sx = startVertices ? startVertices[i] : ox;
                const sy = startVertices ? startVertices[i + 1] : oy;
                const sz = startVertices ? startVertices[i + 2] : oz;
                let bx = ox + (sx - ox) * fEff;
                let by = oy + (sy - oy) * fEff;
                let bz = oz + (sz - oz) * fEff;
                if (params.gaitEnabled && stripeCoord) {
                    const sIdx = (i / 3) | 0;
                    const s = stripeCoord[sIdx];
                    const headW = Math.max(0, (s - params.gaitFrontSplit)) / Math.max(1e-6, 1 - params.gaitFrontSplit);
                    const tailW = 1 - headW;
                    by += headBobY * headW;
                    bz += tailSwayZ * tailW;
                }
                arr[i] += (bx - arr[i]) * Math.min(1, dt * 10);
                arr[i + 1] += (by - arr[i + 1]) * Math.min(1, dt * 10);
                arr[i + 2] += (bz - arr[i + 2]) * Math.min(1, dt * 10);
            }
            updated = true;
        }
        if (updated) posAttr.needsUpdate = true;

        // Compose orientation: base params + gait
        const baseX = baseRot.x;
        const baseY = baseRot.y;
        const baseZ = baseRot.z;
        let addPitch = 0;
        if (params.gaitEnabled && formationDone) {
            const phase = elapsed * params.gaitFreq * Math.PI * 2;
            addPitch = THREE.MathUtils.degToRad(Math.sin(phase) * params.gaitPitchAmpDeg);
        }
        tiger.rotation.set(baseX + addPitch, baseY, baseZ);

        // Update stripes coloring
        if (params.stripesEnabled && !params.stripesGPU) updateStripeColors();
        if (params.stripesEnabled && params.stripesGPU && tiger.material && tiger.material.uniforms) {
            tiger.material.uniforms.uTime.value = elapsed;
        }
    }

    // Walking animation for the whole group
    if (tigerGroup) {
        if (walkRange === 0) {
            // Initialize based on camera distance
            const z = camera.position.z;
            walkRange = z * 0.6; // stays in view
            walkSpeed = params.walkSpeed || (walkRange / 8); // cross in ~8s
        }
        // sync with UI-updated speed
        walkSpeed = params.walkSpeed;
        // Starting position is set during load; no reposition after formation
        // Start walking only after formation completes and not during turning
        if (!params.pauseWalk && formationDone && !isTurning) {
            tigerGroup.position.x += walkDirection * walkSpeed * dt;
            if (params.gaitEnabled) gaitPhase += dt * params.gaitFreq;
        }
        // Handle turning animation at bounds
        if (!isTurning && tigerGroup.position.x > walkRange) {
            tigerGroup.position.x = walkRange;
            isTurning = true;
            turnStart = performance.now();
            turnFrom = tigerGroup.rotation.y;
            turnDelta = Math.PI; // always turn same direction
        } else if (!isTurning && tigerGroup.position.x < -walkRange) {
            tigerGroup.position.x = -walkRange;
            isTurning = true;
            turnStart = performance.now();
            turnFrom = tigerGroup.rotation.y;
            turnDelta = Math.PI; // always turn same direction
        }
        if (isTurning) {
            const t = Math.min(1, (performance.now() - turnStart) / (turnDuration * 1000));
            const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // easeInOutQuad
            const yaw = turnFrom + turnDelta * ease;
            tigerGroup.rotation.y = normalizeAngle(yaw);
            if (t >= 1) {
                isTurning = false;
                walkDirection = (walkDirection === 1) ? -1 : 1;
                tigerGroup.rotation.y = normalizeAngle(turnFrom + turnDelta);
            }
        }
        // Procedural gait translation components (bob/sway)
        if (params.gaitEnabled && formationDone) {
            const phase = elapsed * params.gaitFreq * Math.PI * 2;
            tiger.position.y = Math.sin(phase) * params.gaitBobAmp;
            tiger.position.z = Math.sin(phase * 0.5 + Math.PI * 0.25) * params.gaitSwayAmp;
        }
    }

    // Update pose monitors
    if (tigerGroup) {
        pose.x = tigerGroup.position.x;
        pose.y = tigerGroup.position.y;
        pose.z = tigerGroup.position.z;
        pose.yawDeg = THREE.MathUtils.radToDeg(tigerGroup.rotation.y) % 360;
    }

    if (controls) controls.update();

renderer.render(scene, camera);
}

// --- Helpers ---

function normalizeAngle(a) {
    const TAU = Math.PI * 2;
    a = a % TAU;
    if (a < 0) a += TAU;
    return a;
}

function samplePointsFromGeometry(geometry, count) {
    // Ensure non-indexed geometry to avoid MeshSurfaceSampler conversion warning
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    const mesh = new THREE.Mesh(g);
    const sampler = new MeshSurfaceSampler(mesh).build();
    const positions = new Float32Array(count * 3);
    const tempPosition = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
        sampler.sample(tempPosition);
        positions[i * 3] = tempPosition.x;
        positions[i * 3 + 1] = tempPosition.y;
        positions[i * 3 + 2] = tempPosition.z;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
    return geom;
}

function rebuildPointCloud(mergedGeometry) {
    if (!tiger) return;
    const oriented = orientAndAlign(mergedGeometry);
    const newGeom = samplePointsFromGeometry(oriented, params.pointCount);
    // Dispose old geometry to free memory
    tiger.geometry.dispose();
    tiger.geometry = newGeom;
    // Update original + formation arrays
    const posAttr = tiger.geometry.getAttribute('position');
    originalVertices = Array.from(posAttr.array);
    // Re-init stripes and colors for new geometry
    initStripesData();
    startVertices = new Float32Array(posAttr.array.length);
    const maxDim = tiger.geometry.boundingBox ? tiger.geometry.boundingBox.getSize(new THREE.Vector3()).length() : 1;
    const R = (maxDim || 1) * 10;
    for (let i = 0; i < startVertices.length; i += 3) {
        let x = Math.random() * 2 - 1;
        let y = Math.random() * 2 - 1;
        let z = Math.random() * 2 - 1;
        const len = Math.hypot(x, y, z) || 1;
        x /= len; y /= len; z /= len;
        const r = R * (0.8 + Math.random() * 0.4);
        startVertices[i] = x * r;
        startVertices[i + 1] = y * r;
        startVertices[i + 2] = z * r;
        posAttr.array[i] = startVertices[i];
        posAttr.array[i + 1] = startVertices[i + 1];
        posAttr.array[i + 2] = startVertices[i + 2];
    }
    posAttr.needsUpdate = true;
    formationStart = performance.now();
    formationDone = false;

    // update rotation axis line for new size
    createOrUpdateRotationAxisLine();
    // update gizmo for new size
    const bbox = tiger.geometry.boundingBox;
    const size = new THREE.Vector3();
    bbox.getSize(size);
    createOrUpdateGizmo(Math.max(size.x, size.y, size.z));
    // update floor slider dynamic range if needed
    // keep current value but clamp GUI min/max via helper folder would require recreation; omitted
    // if using GPU stripes, reapply shader material and palette
    if (params.stripesEnabled && params.stripesGPU) {
        switchStripesMaterial(true);
    }
}

function setupGUI(mergedGeometry) {
    const gui = new GUI();
    gui.title('Tiger Controls');
    // Restore main GUI open/closed state
    const savedGuiState = loadGuiState();
    if (savedGuiState && savedGuiState.closed) gui.close();

    // Prevent OrbitControls wheel-zoom and drags when interacting with GUI
    const guiRoot = gui.domElement;
    if (guiRoot) {
        guiRoot.addEventListener('wheel', (e) => { e.stopPropagation(); }, { passive: true });
        guiRoot.addEventListener('mouseenter', () => { if (controls) controls.enabled = false; });
        guiRoot.addEventListener('mouseleave', () => { if (controls) controls.enabled = true; });
    }

    gui.add(params, 'pointCount', 2000, 150000, 1000)
        .name('Density (points)')
        .onFinishChange(() => rebuildPointCloud(mergedGeometry));

    gui.add(params, 'pointSize', 0.0005, 0.05, 0.0005)
        .name('Point Size')
        .onChange((v) => {
            if (tiger) {
                if ('size' in tiger.material) tiger.material.size = v;
                if (tiger.material.uniforms && tiger.material.uniforms.uSize) tiger.material.uniforms.uSize.value = v;
                if (tiger.material.uniforms && tiger.material.uniforms.uHoverRadius) tiger.material.uniforms.uHoverRadius.value = hoverRadius;
                if (tiger.material.uniforms && tiger.material.uniforms.uHoverAmp) tiger.material.uniforms.uHoverAmp.value = wobbleIntensity;
                // Update thresholds tied to size
                hoverRadius = Math.max(hoverRadius, v * 6);
            }
        });

    gui.addColor(params, 'color')
        .name('Color')
        .onChange((v) => {
            if (!tiger) return;
            if (!params.stripesEnabled) {
                // Solid color mode
                tiger.material.color.set(v);
            } else {
                // Stripes mode: derive a custom palette from this color
                setCustomPaletteFromColor(v);
                if (params.stripesGPU) {
                    buildPaletteTexture();
                } else {
                    updateStripeColors(true);
                }
            }
        });

    gui.add(params, 'walkSpeed', 0, 10, 0.1)
        .name('Walk Speed')
        .onChange((v) => { params.walkSpeed = v; });

    gui.add(params, 'pauseWalk')
        .name('Pause Walk');

    gui.add(params, 'rotationSpeed', 0, 2, 0.01)
        .name('Rotation Speed');

    gui.add(params, 'explode', 0, 0.1, 0.001)
        .name('Explode');

    gui.add(params, 'showGrid')
        .name('Show Grid')
        .onChange((v) => { if (gridHelper) gridHelper.visible = v && params.floorStyle === 'Grid'; });
    gui.add(params, 'showWorldAxes')
        .name('Show World Axes')
        .onChange((v) => { if (axesHelper) axesHelper.visible = v; });

    gui.add(params, 'showRotationAxis')
        .name('Show Rotation Axis')
        .onChange((v) => { if (rotationAxisLine) rotationAxisLine.visible = v; });

    gui.add(params, 'showLocalAxes')
        .name('Show Local Axes')
        .onChange((v) => { if (tigerAxesHelper) tigerAxesHelper.visible = v; });

    gui.add(params, 'showGizmo')
        .name('Show Rotation Gizmo')
        .onChange((v) => { if (gizmoGroup) gizmoGroup.visible = v; });

    const floorFolder = gui.addFolder('Floor');
    floorFolder.add(params, 'floorStyle', ['Grid','Grass'])
        .name('Floor Style')
        .onChange((style) => {
            if (gridHelper) gridHelper.visible = params.showGrid && style === 'Grid';
            if (floorMesh) floorMesh.visible = style === 'Grass';
        });
    floorFolder.add(params, 'floorHeight', -5, 5, 0.01)
        .name('Floor Height (Y)')
        .onChange((v) => {
            if (gridHelper) gridHelper.position.y = v;
            if (axesHelper) axesHelper.position.y = v;
            if (floorMesh) floorMesh.position.y = v;
        });
    floorFolder.add({ snap: () => snapFloorToTiger() }, 'snap').name('Snap To Tiger');

    const stripes = gui.addFolder('Stripes');
    stripes.add(params, 'stripesEnabled')
        .name('Enable Stripes')
        .onChange((v) => {
            if (!tiger) return;
            // When enabling stripes, always default to Tiger palette
            if (v) {
                params.palette = 'Tiger';
            }
            tiger.material.vertexColors = v && !params.stripesGPU;
            tiger.material.needsUpdate = true;
            // When disabling, restore solid color
            if (!v) {
                if (tiger.geometry.getAttribute('color')) {
                    tiger.geometry.deleteAttribute('color');
                }
                tiger.material.color.set(params.color);
            } else {
                // ensure color attribute exists and refresh colors
                ensureColorAttribute();
                if (params.stripesGPU) {
                    buildPaletteTexture();
                    switchStripesMaterial(true);
                } else {
                    updateStripeColors(true);
                }
            }
        });
    stripes.add(params, 'stripesGPU')
        .name('Use GPU Shader')
        .onChange((useGPU) => switchStripesMaterial(useGPU));
    stripes.add(params, 'palette', Object.keys(palettes))
        .name('Palette')
        .onChange(() => {
            if (params.stripesGPU) buildPaletteTexture();
            else updateStripeColors(true);
        });
    stripes.add(params, 'stripesCount', 2, 32, 1)
        .name('Stripe Count')
        .onChange(() => {
            if (params.stripesGPU && gpuStripesMaterial) gpuStripesMaterial.uniforms.uStripes.value = params.stripesCount;
            else updateStripeColors(true);
        });
    stripes.add(params, 'stripeSoftness', 0, 1, 0.01)
        .name('Softness')
        .onChange(() => {
            if (params.stripesGPU && gpuStripesMaterial) gpuStripesMaterial.uniforms.uSoftness.value = params.stripeSoftness;
            else updateStripeColors(true);
        });
    stripes.add(params, 'rippleWaves', 0, 10, 1)
        .name('Ripple Waves')
        .onChange(() => {
            if (params.stripesGPU && gpuStripesMaterial) gpuStripesMaterial.uniforms.uWaves.value = params.rippleWaves;
            else updateStripeColors(true);
        });
    stripes.add(params, 'rippleAmplitude', 0, 1, 0.01)
        .name('Ripple Amplitude')
        .onChange(() => { if (params.stripesGPU && gpuStripesMaterial) gpuStripesMaterial.uniforms.uAmp.value = params.rippleAmplitude; });
    stripes.add(params, 'rippleSpeed', 0, 3, 0.01)
        .name('Ripple Speed')
        .onChange(() => { if (params.stripesGPU && gpuStripesMaterial) gpuStripesMaterial.uniforms.uSpeed.value = params.rippleSpeed; });

    const orientFolder = gui.addFolder('Orientation');
    orientFolder.add(params, 'modelUp', ['+X','-X','+Y','-Y','+Z','-Z'])
        .name('Model Up')
        .onFinishChange(() => rebuildPointCloud(mergedGeometry));
    orientFolder.add(params, 'modelForward', ['+X','-X','+Y','-Y','+Z','-Z'])
        .name('Model Forward')
        .onFinishChange(() => rebuildPointCloud(mergedGeometry));

    const manipFolder = gui.addFolder('Orientation Manipulator');
    manipFolder.add(params, 'rotXDeg', -180, 180, 1).name('Rotate X (deg)')
        .onChange(applyOrientationFromParams).listen();
    manipFolder.add(params, 'rotYDeg', -180, 180, 1).name('Rotate Y (deg)')
        .onChange(applyOrientationFromParams).listen();
    manipFolder.add(params, 'rotZDeg', -180, 180, 1).name('Rotate Z (deg)')
        .onChange(applyOrientationFromParams).listen();
    manipFolder.add({ reset: () => { params.rotXDeg = 0; params.rotYDeg = 0; params.rotZDeg = 0; applyOrientationFromParams(); }}, 'reset')
        .name('Reset Orientation');

    const wobbleFolder = gui.addFolder('Wobble');
    wobbleFolder.add(params, 'wobbleIntensityMult', 0.2, 5, 0.1).name('Intensity x');
    wobbleFolder.add(params, 'wobbleRadiusMult', 0.5, 3, 0.1).name('Radius x');
    wobbleFolder.add(params, 'wobbleNoiseSpeed', 0, 4, 0.1).name('Noise Speed');
    wobbleFolder.add(params, 'wobbleSizeBoost', 0, 6, 0.1).name('Size Boost')
        .onChange((v)=>{ if (tiger && tiger.material && tiger.material.uniforms && tiger.material.uniforms.uHoverSizeBoost) tiger.material.uniforms.uHoverSizeBoost.value = v; });

    const gaitFolder = gui.addFolder('Gait');
    gaitFolder.add(params, 'gaitEnabled').name('Enable Gait');
    gaitFolder.add(params, 'gaitBobAmp', 0, 0.2, 0.005).name('Bob Amp');
    gaitFolder.add(params, 'gaitSwayAmp', 0, 0.2, 0.005).name('Sway Amp');
    gaitFolder.add(params, 'gaitPitchAmpDeg', 0, 10, 0.1).name('Pitch Amp (deg)');
    gaitFolder.add(params, 'gaitFreq', 0, 3, 0.05).name('Gait Freq');
    gaitFolder.add(params, 'gaitHeadBobAmp', 0, 0.2, 0.005).name('Head Bob (front)');
    gaitFolder.add(params, 'gaitTailSwayAmp', 0, 0.2, 0.005).name('Tail Sway (rear)');
    gaitFolder.add(params, 'gaitFrontSplit', 0.2, 0.9, 0.01).name('Front Split');

    const poseFolder = gui.addFolder('Pose (read-only)');
    poseFolder.add(pose, 'x').name('X').listen();
    poseFolder.add(pose, 'y').name('Y').listen();
    poseFolder.add(pose, 'z').name('Z').listen();
    poseFolder.add(pose, 'yawDeg').name('Yaw (deg)').listen();

    // Apply saved folder collapsed states
    if (savedGuiState && savedGuiState.folders) {
        const F = savedGuiState.folders;
        try {
            if (F.Stripes) stripes.close(); else stripes.open();
            if (F.Orientation) orientFolder.close(); else orientFolder.open();
            if (F.OrientationManipulator) manipFolder.close(); else manipFolder.open();
            if (F.Wobble) wobbleFolder.close(); else wobbleFolder.open();
            if (F.Gait) gaitFolder.close(); else gaitFolder.open();
            if (F.Floor) floorFolder.close(); else floorFolder.open();
        } catch (e) { console.warn('Failed to apply GUI folder state', e); }
    }

    // Save GUI state whenever we save params
    const origSave = saveParams;
    window._pctigerSaveHook = () => {
        try {
            const gs = {
                closed: !!gui._closed,
                folders: {
                    Stripes: !!stripes._closed,
                    Orientation: !!orientFolder._closed,
                    OrientationManipulator: !!manipFolder._closed,
                    Wobble: !!wobbleFolder._closed,
                    Gait: !!gaitFolder._closed,
                    Floor: !!floorFolder._closed,
                }
            };
            localStorage.setItem(GUI_STATE_KEY, JSON.stringify(gs));
        } catch (e) { /* ignore */ }
        origSave();
    };
}

function axisStringToVector(s) {
    switch (s) {
        case '+X': return new THREE.Vector3(1,0,0);
        case '-X': return new THREE.Vector3(-1,0,0);
        case '+Y': return new THREE.Vector3(0,1,0);
        case '-Y': return new THREE.Vector3(0,-1,0);
        case '+Z': return new THREE.Vector3(0,0,1);
        case '-Z': return new THREE.Vector3(0,0,-1);
        default: return new THREE.Vector3(0,1,0);
    }
}

function orientAndAlign(geometry) {
    const g = geometry.clone();
    // Build basis mapping from model (up/forward) to world (up=+Y, fwd=+X)
    const u_m = axisStringToVector(params.modelUp).clone().normalize();
    const f_m = axisStringToVector(params.modelForward).clone().normalize();
    // Orthonormalize: ensure forward is perpendicular to up
    const r_m = new THREE.Vector3().crossVectors(f_m, u_m).normalize();
    const f_m_ortho = new THREE.Vector3().crossVectors(u_m, r_m).normalize();

    const u_w = new THREE.Vector3(0,1,0);
    const f_w = new THREE.Vector3(1,0,0);
    const r_w = new THREE.Vector3().crossVectors(f_w, u_w).normalize();

    const m_m = new THREE.Matrix3(); // columns = r,u,f
    m_m.set(
        r_m.x, u_m.x, f_m_ortho.x,
        r_m.y, u_m.y, f_m_ortho.y,
        r_m.z, u_m.z, f_m_ortho.z,
    );
    const m_w = new THREE.Matrix3();
    m_w.set(
        r_w.x, u_w.x, f_w.x,
        r_w.y, u_w.y, f_w.y,
        r_w.z, u_w.z, f_w.z,
    );
    const rot3 = new THREE.Matrix3().multiplyMatrices(m_w, m_m.clone().transpose());
    const rot4 = new THREE.Matrix4().setFromMatrix3(rot3);
    g.applyMatrix4(rot4);

    // Align to datum: base on Y=0, center X/Z
    g.computeBoundingBox();
    const box = g.boundingBox;
    const center = new THREE.Vector3();
    box.getCenter(center);
    g.translate(-center.x, -box.min.y, -center.z);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
}

function createOrUpdateRotationAxisLine() {
    if (!tiger) return;
    const bbox = tiger.geometry.boundingBox;
    const size = new THREE.Vector3();
    bbox.getSize(size);
    const L = Math.max(size.x, size.y, size.z) * 1.2;

    if (!rotationAxisLine) {
        const geo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, -L, 0),
            new THREE.Vector3(0,  L, 0),
        ]);
        const mat = new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.1 * L, gapSize: 0.05 * L });
        rotationAxisLine = new THREE.Line(geo, mat);
        rotationAxisLine.computeLineDistances();
        tiger.add(rotationAxisLine);
    } else {
        const pos = rotationAxisLine.geometry.getAttribute('position');
        pos.setXYZ(0, 0, -L, 0);
        pos.setXYZ(1, 0,  L, 0);
        pos.needsUpdate = true;
        rotationAxisLine.computeLineDistances();
    }
    rotationAxisLine.visible = params.showRotationAxis;
}

function createOrUpdateGrassFloor(span) {
    // span ~ scene size (x/z)
    const size = Math.max(10, span);
    if (!grassMaterial) {
        const uniforms = {
            uColor1: { value: new THREE.Color('#184d27') },
            uColor2: { value: new THREE.Color('#2f8f2f') },
            uScale:  { value: 0.2 },
        };
        const vtx = `
            varying vec2 vUv;
            void main(){
                vUv = uv * 10.0; // tile
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
            }
        `;
        const frg = `
            precision mediump float;
            varying vec2 vUv;
            uniform vec3 uColor1, uColor2;
            uniform float uScale;
            // simple value noise
            float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
            float noise(vec2 p){
              vec2 i=floor(p), f=fract(p);
              float a=hash(i);
              float b=hash(i+vec2(1.0,0.0));
              float c=hash(i+vec2(0.0,1.0));
              float d=hash(i+vec2(1.0,1.0));
              vec2 u=f*f*(3.0-2.0*f);
              return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
            }
            void main(){
              float n = noise(vUv * (4.0/uScale)) * 0.6 + noise(vUv * (8.0/uScale)) * 0.4;
              n = smoothstep(0.2, 0.8, n);
              vec3 col = mix(uColor1, uColor2, n);
              gl_FragColor = vec4(col, 1.0);
            }
        `;
        grassMaterial = new THREE.ShaderMaterial({ vertexShader: vtx, fragmentShader: frg });
    }
    if (!floorMesh) {
        const geo = new THREE.PlaneGeometry(size, size, 1, 1);
        floorMesh = new THREE.Mesh(geo, grassMaterial);
        floorMesh.rotation.x = -Math.PI / 2;
        floorMesh.position.y = params.floorHeight || 0;
        scene.add(floorMesh);
    } else {
        // Resize if needed
        const need = Math.max(floorMesh.geometry.parameters.width, floorMesh.geometry.parameters.height);
        if (Math.abs(need - size) > 1e-3) {
            floorMesh.geometry.dispose();
            floorMesh.geometry = new THREE.PlaneGeometry(size, size, 1, 1);
        }
        floorMesh.position.y = params.floorHeight || 0;
    }
    floorMesh.visible = params.floorStyle === 'Grass';
}

function createOrUpdateGizmo(maxDim) {
    if (!tiger) return;
    const L = Math.max(0.001, maxDim * 0.6);
    const ringR = L * 0.18;
    const tubeR = L * 0.01;

    if (!gizmoGroup) {
        gizmoGroup = new THREE.Group();
        tiger.add(gizmoGroup);
    }
    // Clear previous children
    while (gizmoGroup.children.length) {
        const c = gizmoGroup.children.pop();
        c.geometry && c.geometry.dispose && c.geometry.dispose();
        c.material && c.material.dispose && c.material.dispose();
    }

    // Helper to build a ring oriented along axis and positioned at axis end
    const makeRing = (axis) => {
        const geo = new THREE.TorusGeometry(ringR, tubeR, 24, 64);
        const color = axis === 'x' ? 0xff4444 : axis === 'y' ? 0x44ff44 : 0x4488ff;
        const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false });
        const mesh = new THREE.Mesh(geo, mat);
        // Orient torus axis to align with requested axis
        if (axis === 'x') mesh.rotation.z = Math.PI / 2;
        if (axis === 'z') mesh.rotation.x = Math.PI / 2;
        // Place at end of axis
        if (axis === 'x') mesh.position.set(L, 0, 0);
        if (axis === 'y') mesh.position.set(0, L, 0);
        if (axis === 'z') mesh.position.set(0, 0, L);
        mesh.renderOrder = 999;
        mesh.userData.gizmoAxis = axis;
        return mesh;
    };

    gizmoRings.x = makeRing('x');
    gizmoRings.y = makeRing('y');
    gizmoRings.z = makeRing('z');
    gizmoGroup.add(gizmoRings.x, gizmoRings.y, gizmoRings.z);
    gizmoGroup.visible = params.showGizmo;

    // Add positive axis arrows for clarity
    const addArrow = (dir, color) => {
        const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(0, 0, 0), L, color, L * 0.12, L * 0.06);
        gizmoGroup.add(arrow);
    };
    addArrow(new THREE.Vector3(1, 0, 0), 0xff4444);
    addArrow(new THREE.Vector3(0, 1, 0), 0x44ff44);
    addArrow(new THREE.Vector3(0, 0, 1), 0x4488ff);
}

function applyOrientationFromParams() {
    // Store base rotation (radians); animate() composes with gait each frame
    baseRot.x = THREE.MathUtils.degToRad(params.rotXDeg);
    baseRot.y = THREE.MathUtils.degToRad(params.rotYDeg);
    baseRot.z = THREE.MathUtils.degToRad(params.rotZDeg);
}

function snapFloorToTiger() {
    if (!gridHelper || !tiger) return;
    const box = new THREE.Box3().setFromObject(tiger);
    const minY = box.min.y;
    gridHelper.position.y = minY;
    params.floorHeight = minY;
}

function onDocumentMouseDown(event) {
    if (!tiger || !gizmoGroup || !params.showGizmo) return;
    const mouse = new THREE.Vector2(
        (event.clientX / window.innerWidth) * 2 - 1,
        -(event.clientY / window.innerHeight) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);
    const pickables = [gizmoRings.x, gizmoRings.y, gizmoRings.z].filter(Boolean);
    const hits = raycaster.intersectObjects(pickables, true);
    if (hits.length > 0) {
        const hit = hits[0];
        const axis = hit.object.userData.gizmoAxis;
        if (!axis) return;
        // Setup drag
        isDraggingGizmo = true;
        activeAxis = axis;
        if (controls) controls.enabled = false;

        // Compute ring center in world
        const center = hit.object.getWorldPosition(new THREE.Vector3());

        // Axis in world
        const axisWorld = new THREE.Vector3(
            axis === 'x' ? 1 : 0,
            axis === 'y' ? 1 : 0,
            axis === 'z' ? 1 : 0
        ).applyQuaternion(tiger.getWorldQuaternion(new THREE.Quaternion()));
        axisWorld.normalize();

        // Initial vector from ring center to hit point, projected onto plane
        const hitPoint = hit.point.clone();
        const v0 = hitPoint.clone().sub(center);
        const vStart = v0.clone().sub(axisWorld.clone().multiplyScalar(v0.dot(axisWorld))).normalize();

        dragStartInfo = {
            axis,
            center,
            axisWorld,
            startVec: vStart,
            startRot: { x: tiger.rotation.x, y: tiger.rotation.y, z: tiger.rotation.z },
            startParams: {
                x: THREE.MathUtils.degToRad(params.rotXDeg),
                y: THREE.MathUtils.degToRad(params.rotYDeg),
                z: THREE.MathUtils.degToRad(params.rotZDeg),
            },
        };
        event.preventDefault();
    }
}

function onDocumentMouseUp() {
    if (isDraggingGizmo) {
        isDraggingGizmo = false;
        activeAxis = null;
        dragStartInfo = null;
        if (controls) controls.enabled = true;
        // GUI already reflects params updated during drag
        applyOrientationFromParams();
    }
}

function updateGizmoDrag(raycaster) {
    if (!dragStartInfo || !activeAxis) return;
    // Build plane for the active ring (perpendicular to axis, passing through center)
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(dragStartInfo.axisWorld, dragStartInfo.center);
    const ray = raycaster.ray;
    const hitPoint = new THREE.Vector3();
    if (!ray.intersectPlane(plane, hitPoint)) return;

    // Current vector on the plane from center to hit
    const v = hitPoint.clone().sub(dragStartInfo.center);
    const vProj = v.clone().sub(dragStartInfo.axisWorld.clone().multiplyScalar(v.dot(dragStartInfo.axisWorld)));
    if (vProj.lengthSq() < 1e-8) return;
    const vCur = vProj.normalize();

    // Signed angle around axisWorld
    const cross = new THREE.Vector3().crossVectors(dragStartInfo.startVec, vCur);
    const sin = dragStartInfo.axisWorld.dot(cross);
    const cos = dragStartInfo.startVec.dot(vCur);
    const delta = Math.atan2(sin, cos);

    // Update base orientation params instead of directly rotating mesh
    if (activeAxis === 'x') params.rotXDeg = THREE.MathUtils.radToDeg(dragStartInfo.startParams.x + delta);
    if (activeAxis === 'y') params.rotYDeg = THREE.MathUtils.radToDeg(dragStartInfo.startParams.y + delta);
    if (activeAxis === 'z') params.rotZDeg = THREE.MathUtils.radToDeg(dragStartInfo.startParams.z + delta);
    applyOrientationFromParams();
}
// --- Stripes / Ripple Coloring ---

function initStripesData() {
    if (!tiger) return;
    const geom = tiger.geometry;
    const pos = geom.getAttribute('position');
    const count = pos.count;
    // Build normalized stripe coordinate along X after orientation
    geom.computeBoundingBox();
    const minX = geom.boundingBox.min.x;
    const maxX = geom.boundingBox.max.x;
    const span = Math.max(1e-6, maxX - minX);
    stripeCoord = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        const x = pos.getX(i);
        stripeCoord[i] = (x - minX) / span; // 0..1
    }
    // Attach stripe coordinate as attribute for shaders
    geom.setAttribute('aStripe', new THREE.BufferAttribute(stripeCoord, 1));
    // Ensure color attribute exists if stripes enabled
    if (params.stripesEnabled) {
        ensureColorAttribute();
        if (!params.stripesGPU) {
            updateStripeColors(true);
            tiger.material.vertexColors = true;
            tiger.material.needsUpdate = true;
        } else {
            switchStripesMaterial(true);
        }
    }
}

function ensureColorAttribute() {
    if (!tiger) return;
    const geom = tiger.geometry;
    const count = geom.getAttribute('position').count;
    let attr = geom.getAttribute('color');
    if (!attr || attr.count !== count) {
        colorArray = new Float32Array(count * 3);
        geom.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));
    } else {
        colorArray = attr.array;
    }
}

function getActivePalette() {
    const list = palettes[params.palette] || palettes.Tiger;
    // Convert to THREE.Color instances once per call
    return list.map((hex) => new THREE.Color(hex));
}

function lerpColor(c1, c2, t) {
    // simple linear interpolation in RGB space
    return new THREE.Color(
        c1.r + (c2.r - c1.r) * t,
        c1.g + (c2.g - c1.g) * t,
        c1.b + (c2.b - c1.b) * t,
    );
}

function updateStripeColors(force = false) {
    if (!tiger || !params.stripesEnabled) return;
    ensureColorAttribute();
    const now = performance.now();
    if (!force) {
        const minDelta = 1000 / targetColorFPS;
        if (now - lastColorUpdate < minDelta) return;
    }
    lastColorUpdate = now;

    const geom = tiger.geometry;
    const count = geom.getAttribute('position').count;
    const attr = geom.getAttribute('color');
    const arr = attr.array;
    const palette = getActivePalette();
    const P = palette.length;

    const t = now * 0.001; // seconds
    const stripes = Math.max(1, Math.floor(params.stripesCount));
    const waves = Math.max(0, Math.floor(params.rippleWaves));
    const amp = Math.max(0, Math.min(1, params.rippleAmplitude));
    const speed = Math.max(0, params.rippleSpeed);
    // Map softness 0..1 to gamma 8..0.5 (lower gamma = softer blend)
    const gamma = THREE.MathUtils.lerp(8, 0.5, Math.max(0, Math.min(1, params.stripeSoftness)));

    for (let i = 0; i < count; i++) {
        const s = stripeCoord ? stripeCoord[i] : 0; // 0..1
        const phase = s * stripes + amp * Math.sin(2 * Math.PI * (s * waves - t * speed));
        const base = Math.floor(phase);
        const frac = phase - base; // 0..1
        let mix = Math.pow(frac, gamma);
        const i1 = ((base % P) + P) % P;
        const i2 = ((i1 + 1) % P);
        const c = lerpColor(palette[i1], palette[i2], mix);
        const j = i * 3;
        arr[j] = c.r;
        arr[j + 1] = c.g;
        arr[j + 2] = c.b;
    }
    attr.needsUpdate = true;
}

function buildPaletteTexture() {
    const list = palettes[params.palette] || palettes.Tiger;
    const w = 256, h = 1;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    for (let i = 0; i < list.length; i++) {
        const t = i / (list.length - 1);
        grad.addColorStop(t, list[i]);
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    paletteTexture = tex;
    if (gpuStripesMaterial) gpuStripesMaterial.uniforms.uPalette.value = paletteTexture;
}

function buildGPUStripesMaterial() {
    if (!paletteTexture) buildPaletteTexture();
    const uniforms = {
        uTime: { value: 0 },
        uStripes: { value: params.stripesCount },
        uWaves: { value: params.rippleWaves },
        uAmp: { value: params.rippleAmplitude },
        uSpeed: { value: params.rippleSpeed },
        uSoftness: { value: params.stripeSoftness },
        uSize: { value: params.pointSize },
        uPalette: { value: paletteTexture },
        // Wobble uniforms (hover-driven)
        uHover: { value: new THREE.Vector3(0,0,0) },
        uHoverActive: { value: 0.0 },
        uHoverRadius: { value: hoverRadius || 0.2 },
        uHoverAmp: { value: wobbleIntensity || 0.05 },
        uHoverSizeBoost: { value: 2.5 },
        uPixelRatio: { value: (typeof window !== 'undefined' ? window.devicePixelRatio : 1) },
    };

    const vertexShader = `
        attribute float aStripe;
        uniform float uSize;
        uniform vec3 uHover;
        uniform float uHoverActive;
        uniform float uHoverRadius;
        uniform float uHoverAmp;
        uniform float uTime;
        uniform float uPixelRatio;
        uniform float uHoverSizeBoost;
        varying float vStripe;
        varying vec3 vWorldPos;
        void main() {
            vStripe = aStripe;
            vec3 pos = position;
            float sizeBoost = 0.0;
            // Hover wobble in local space with smooth radial falloff and coherent dir
            if (uHoverActive > 0.5) {
                vec3 dp = pos - uHover;
                float d = length(dp);
                if (d < uHoverRadius) {
                    float w = 1.0 - smoothstep(0.0, uHoverRadius, d);
                    // Cheap coherent direction and time variation
                    float s1 = sin(dot(pos, vec3(12.9898,78.233,37.719)) + uTime * 4.0);
                    vec3 dir = normalize(vec3(
                        sin(pos.x*1.3 + 0.0),
                        sin(pos.y*1.7 + 1.0),
                        sin(pos.z*1.9 + 2.0)
                    ));
                    pos += dir * (uHoverAmp * w * s1);
                    sizeBoost = uHoverSizeBoost * w;
                }
            }
            vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
            float perspective = 300.0 / max(0.001, -mvPosition.z);
            gl_PointSize = max(1.0, uSize * perspective * uPixelRatio) * (1.0 + sizeBoost);
            gl_Position = projectionMatrix * mvPosition;
            vWorldPos = (modelMatrix * vec4(position,1.0)).xyz;
        }
    `;
    const fragmentShader = `
        precision mediump float;
        varying float vStripe;
        uniform float uTime, uStripes, uWaves, uAmp, uSpeed, uSoftness;
        uniform sampler2D uPalette;
        void main() {
            float phase = vStripe * uStripes + uAmp * sin(6.2831853 * (vStripe * uWaves - uTime * uSpeed));
            float frac = phase - floor(phase);
            float gamma = mix(8.0, 0.5, clamp(uSoftness, 0.0, 1.0));
            float t = pow(frac, gamma);
            vec3 col = texture2D(uPalette, vec2(t, 0.5)).rgb;
            // round point
            vec2 c = gl_PointCoord * 2.0 - 1.0;
            float m = 1.0 - dot(c, c);
            if (m <= 0.0) discard;
            gl_FragColor = vec4(col, 1.0);
        }
    `;
    const mat = new THREE.ShaderMaterial({
        uniforms,
        vertexShader,
        fragmentShader,
        transparent: false,
        depthTest: true,
    });
    mat.extensions = { derivatives: false }; // keep simple
    return mat;
}

function switchStripesMaterial(useGPU) {
    if (!tiger) return;
    if (useGPU) {
        if (!gpuStripesMaterial) gpuStripesMaterial = buildGPUStripesMaterial();
        tiger.material = gpuStripesMaterial;
        if (tiger.material.uniforms && tiger.material.uniforms.uSize) {
            tiger.material.uniforms.uSize.value = params.pointSize;
        }
        // Sync wobble uniforms to current values
        if (tiger.material.uniforms) {
            tiger.material.uniforms.uHoverRadius.value = hoverRadius || tiger.material.uniforms.uHoverRadius.value;
            tiger.material.uniforms.uHoverAmp.value = wobbleIntensity || tiger.material.uniforms.uHoverAmp.value;
            if (tiger.material.uniforms.uHoverSizeBoost) tiger.material.uniforms.uHoverSizeBoost.value = params.wobbleSizeBoost;
            if (tiger.material.uniforms.uPixelRatio) tiger.material.uniforms.uPixelRatio.value = window.devicePixelRatio || 1;
        }
        tiger.material.needsUpdate = true;
        // GPU uses color in shader; ensure attribute exists
        if (!tiger.geometry.getAttribute('aStripe') && stripeCoord) {
            tiger.geometry.setAttribute('aStripe', new THREE.BufferAttribute(stripeCoord, 1));
        }
    } else {
        // Back to CPU PointsMaterial
        if (!cpuPointsMaterial) {
            cpuPointsMaterial = new THREE.PointsMaterial({ color: params.color, size: params.pointSize, sizeAttenuation: true });
        }
        tiger.material = cpuPointsMaterial;
        tiger.material.vertexColors = params.stripesEnabled;
        tiger.material.needsUpdate = true;
        updateStripeColors(true);
    }
}

function setCustomPaletteFromColor(hex) {
    try {
        const c = new THREE.Color(hex);
        const dark = new THREE.Color(c.r * 0.15, c.g * 0.15, c.b * 0.15);
        const mid = new THREE.Color(c.r * 0.5, c.g * 0.5, c.b * 0.5);
        palettes.Custom = [ '#' + dark.getHexString(), '#' + c.getHexString(), '#' + mid.getHexString(), '#' + c.getHexString() ];
        params.palette = 'Custom';
    } catch (e) {
        console.warn('Failed to build custom palette', e);
    }
}

function onDocumentMouseMove(event) {
    event.preventDefault();

    if (!tiger) return;

    const mouse = new THREE.Vector2();
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);

    // Handle gizmo dragging first
    if (isDraggingGizmo && activeAxis && dragStartInfo) {
        updateGizmoDrag(raycaster);
        return; // skip wobble during drag
    }
    // Use world-space hover radius for hit testing to match wobble area
    raycaster.params.Points.threshold = Math.max(hoverRadius, 0.01);

    const intersects = raycaster.intersectObject(tiger);
    if (intersects.length > 0) {
        const hit = intersects[0];
        const p = hit.point.clone(); // world space
        hoverPointLocal = tiger.worldToLocal(p);
        // Feed GPU wobble uniforms when stripes shader is active
        if (params.stripesEnabled && params.stripesGPU && tiger.material && tiger.material.uniforms) {
            tiger.material.uniforms.uHover.value.copy(hoverPointLocal);
            tiger.material.uniforms.uHoverActive.value = 1.0;
            tiger.material.uniforms.uHoverRadius.value = hoverRadius;
            tiger.material.uniforms.uHoverAmp.value = wobbleIntensity;
        }
    } else {
        hoverPointLocal = null;
        if (params.stripesEnabled && params.stripesGPU && tiger.material && tiger.material.uniforms) {
            tiger.material.uniforms.uHoverActive.value = 0.0;
        }
    }
}

init();

// --- Persistence ---
function saveParams() {
    try {
        const toSave = { ...params };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    } catch (e) { console.warn('Failed to save params', e); }
}

function loadSavedParams() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (!data || typeof data !== 'object') return;
        for (const k in params) {
            if (Object.prototype.hasOwnProperty.call(data, k)) {
                const v = data[k];
                if (typeof v === typeof params[k]) params[k] = v;
                loadedParamsKeys.add(k);
            }
        }
    } catch (e) { console.warn('Failed to load saved params', e); }
}

function loadGuiState() {
    try {
        const raw = localStorage.getItem(GUI_STATE_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch {
        return null;
    }
}
