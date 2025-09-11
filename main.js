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

// Local axes + gizmo
let tigerAxesHelper = null;
let gizmoGroup = null;
let gizmoRings = { x: null, y: null, z: null };
let isDraggingGizmo = false;
let activeAxis = null; // 'x' | 'y' | 'z' | null
let dragStartInfo = null; // { axis: 'x', center: Vector3, axisWorld: Vector3, startVec: Vector3, startRot: {x,y,z} }

// UI params
const params = {
    pointCount: 30000,
    pointSize: 0.01,
    color: '#ff8800',
    walkSpeed: 0, // set after camera init
    pauseWalk: false,
    rotationSpeed: 0.0, // rad/s applied to tiger (not group yaw)
    showGrid: true,
    explode: 0.0, // 0 formed .. 1 fully exploded
    showRotationAxis: true,
    showLocalAxes: true,
    showGizmo: true,
    modelUp: '+Y',
    modelForward: '+X',
    // Stripes
    stripesEnabled: true,
    stripesCount: 8,
    rippleSpeed: 0.6,     // cycles per second
    rippleAmplitude: 0.4, // 0..1 offset of stripe phase
    rippleWaves: 2,       // additional wave count across body
    stripeSoftness: 0.25, // 0 hard bands .. 1 very soft
    palette: 'Tiger',
    // Orientation manipulator (degrees)
    rotXDeg: 0,
    rotYDeg: 0,
    rotZDeg: 0,
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
        // Default visual scale
        const pointSize = Math.max(maxDim * 0.0015, 0.0025);
        params.pointSize = pointSize;
        params.pointCount = Math.min(60000, Math.max(8000, Math.floor((size.x * size.y + size.z * size.x + size.y * size.z) * 120)));

        const material = new THREE.PointsMaterial({
            color: new THREE.Color(params.color),
            size: params.pointSize,
            sizeAttenuation: true
        });

        // Build initial sampled point cloud for adjustable density
        const sampled = samplePointsFromGeometry(oriented, params.pointCount);
        tiger = new THREE.Points(sampled, material);
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
            gridHelper.position.y = 0;
            scene.add(gridHelper);
            axesHelper = new THREE.AxesHelper(maxDim * 0.6);
            scene.add(axesHelper);
            helpersAdded = true;
        }
        if (gridHelper) gridHelper.visible = params.showGrid;
        if (axesHelper) axesHelper.visible = params.showGrid;

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
        wobbleIntensity = Math.max(maxDim * 0.004, params.pointSize * 0.75);
        hoverRadius = Math.max(maxDim * 0.06, params.pointSize * 6);

        // Init walk speed option based on camera distance
        params.walkSpeed = (camera.position.z * 0.6) / 8; // cross ~8s by default

        // Build UI
        setupGUI(baseMergedGeometry);

        // Create rotation axis visualization
        createOrUpdateRotationAxisLine();

        // Create local axes helper attached to tiger
        if (!tigerAxesHelper) {
            tigerAxesHelper = new THREE.AxesHelper(Math.max(size.x, size.y, size.z) * 0.6);
            tiger.add(tigerAxesHelper);
        } else {
            tigerAxesHelper.scale.setScalar(Math.max(size.x, size.y, size.z) * 0.6 / tigerAxesHelper.size || 1);
        }
        tigerAxesHelper.visible = params.showLocalAxes;

        // Create rotation gizmo rings
        createOrUpdateGizmo(Math.max(size.x, size.y, size.z));

    }, undefined, (error) => {
        console.error("Error loading tiger model:", error);
    });

    window.addEventListener('resize', onWindowResize, false);
    document.addEventListener('mousemove', onDocumentMouseMove, false);
    document.addEventListener('mousedown', onDocumentMouseDown, false);
    document.addEventListener('mouseup', onDocumentMouseUp, false);

    animate();
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// Walking motion across a range
let walkDirection = 1;
let walkRange = 0; // set after load via cameraZ or model size
let walkSpeed = 0; // units per second

function animate() {
    requestAnimationFrame(animate);

    const dt = clock.getDelta();

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

        // Update positions toward base (lerp of original and start)
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
                const bx = ox + (sx - ox) * fEff;
                const by = oy + (sy - oy) * fEff;
                const bz = oz + (sz - oz) * fEff;
                const dx = bx - hx;
                const dy = by - hy;
                const dz = bz - hz;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 < r2) {
                    const d = Math.sqrt(Math.max(d2, 1e-6));
                    const falloff = 1 - d / hoverRadius; // 0..1
                    const amp = wobbleIntensity * falloff * falloff;
                    arr[i] = bx + (Math.random() - 0.5) * amp;
                    arr[i + 1] = by + (Math.random() - 0.5) * amp;
                    arr[i + 2] = bz + (Math.random() - 0.5) * amp;
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
                const bx = ox + (sx - ox) * fEff;
                const by = oy + (sy - oy) * fEff;
                const bz = oz + (sz - oz) * fEff;
                arr[i] += (bx - arr[i]) * Math.min(1, dt * 10);
                arr[i + 1] += (by - arr[i + 1]) * Math.min(1, dt * 10);
                arr[i + 2] += (bz - arr[i + 2]) * Math.min(1, dt * 10);
            }
            updated = true;
        }
        if (updated) posAttr.needsUpdate = true;

        // Optional independent rotation animation (about local Y)
        if (params.rotationSpeed) {
            tiger.rotation.y += params.rotationSpeed * dt;
        }

        // Update per-vertex colors if stripes enabled
        if (params.stripesEnabled) {
            updateStripeColors();
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
        if (!params.pauseWalk) {
            tigerGroup.position.x += walkDirection * walkSpeed * dt;
        }
        if (tigerGroup.position.x > walkRange) {
            walkDirection = -1;
            tigerGroup.position.x = walkRange;
            tigerGroup.rotation.y = Math.PI; // face back
        } else if (tigerGroup.position.x < -walkRange) {
            walkDirection = 1;
            tigerGroup.position.x = -walkRange;
            tigerGroup.rotation.y = 0;
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

function samplePointsFromGeometry(geometry, count) {
    const mesh = new THREE.Mesh(geometry);
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
}

function setupGUI(mergedGeometry) {
    const gui = new GUI();
    gui.title('Tiger Controls');

    gui.add(params, 'pointCount', 2000, 150000, 1000)
        .name('Density (points)')
        .onFinishChange(() => rebuildPointCloud(mergedGeometry));

    gui.add(params, 'pointSize', 0.0005, 0.05, 0.0005)
        .name('Point Size')
        .onChange((v) => {
            if (tiger) {
                tiger.material.size = v;
                // Update thresholds tied to size
                hoverRadius = Math.max(hoverRadius, v * 6);
            }
        });

    gui.addColor(params, 'color')
        .name('Color')
        .onChange((v) => {
            if (tiger && !params.stripesEnabled) {
                tiger.material.color.set(v);
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
        .name('Show Grid/Axes')
        .onChange((v) => {
            if (gridHelper) gridHelper.visible = v;
            if (axesHelper) axesHelper.visible = v;
        });

    gui.add(params, 'showRotationAxis')
        .name('Show Rotation Axis')
        .onChange((v) => { if (rotationAxisLine) rotationAxisLine.visible = v; });

    gui.add(params, 'showLocalAxes')
        .name('Show Local Axes')
        .onChange((v) => { if (tigerAxesHelper) tigerAxesHelper.visible = v; });

    gui.add(params, 'showGizmo')
        .name('Show Rotation Gizmo')
        .onChange((v) => { if (gizmoGroup) gizmoGroup.visible = v; });

    const stripes = gui.addFolder('Stripes');
    stripes.add(params, 'stripesEnabled')
        .name('Enable Stripes')
        .onChange((v) => {
            if (!tiger) return;
            tiger.material.vertexColors = v;
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
                updateStripeColors(true);
            }
        });
    stripes.add(params, 'palette', Object.keys(palettes))
        .name('Palette')
        .onChange(() => updateStripeColors(true));
    stripes.add(params, 'stripesCount', 2, 32, 1)
        .name('Stripe Count')
        .onChange(() => updateStripeColors(true));
    stripes.add(params, 'stripeSoftness', 0, 1, 0.01)
        .name('Softness')
        .onChange(() => updateStripeColors(true));
    stripes.add(params, 'rippleWaves', 0, 10, 1)
        .name('Ripple Waves')
        .onChange(() => updateStripeColors(true));
    stripes.add(params, 'rippleAmplitude', 0, 1, 0.01)
        .name('Ripple Amplitude');
    stripes.add(params, 'rippleSpeed', 0, 3, 0.01)
        .name('Ripple Speed');

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

    const poseFolder = gui.addFolder('Pose (read-only)');
    poseFolder.add(pose, 'x').name('X').listen();
    poseFolder.add(pose, 'y').name('Y').listen();
    poseFolder.add(pose, 'z').name('Z').listen();
    poseFolder.add(pose, 'yawDeg').name('Yaw (deg)').listen();
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
    if (!tiger) return;
    tiger.rotation.x = THREE.MathUtils.degToRad(params.rotXDeg);
    tiger.rotation.y = THREE.MathUtils.degToRad(params.rotYDeg);
    tiger.rotation.z = THREE.MathUtils.degToRad(params.rotZDeg);
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
        const L = hit.object.position.clone().applyMatrix4(hit.object.matrixWorld.clone().multiply(new THREE.Matrix4().makeTranslation(0,0,0)));
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
        // Sync GUI with current rotation
        params.rotXDeg = THREE.MathUtils.radToDeg(tiger.rotation.x);
        params.rotYDeg = THREE.MathUtils.radToDeg(tiger.rotation.y);
        params.rotZDeg = THREE.MathUtils.radToDeg(tiger.rotation.z);
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

    // Apply rotation around the active axis in local space by delta (relative to drag start)
    if (activeAxis === 'x') tiger.rotation.x = dragStartInfo.startRot.x + delta;
    if (activeAxis === 'y') tiger.rotation.y = dragStartInfo.startRot.y + delta;
    if (activeAxis === 'z') tiger.rotation.z = dragStartInfo.startRot.z + delta;
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
    // Ensure color attribute exists if stripes enabled
    if (params.stripesEnabled) {
        ensureColorAttribute();
        updateStripeColors(true);
        tiger.material.vertexColors = true;
        tiger.material.needsUpdate = true;
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
    } else {
        hoverPointLocal = null;
    }
}

init();
