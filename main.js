import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeBufferGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';
import GUI from 'three/addons/libs/lil-gui.module.min.js';

let scene, camera, renderer, controls, tiger, tigerGroup;
let originalVertices = [];
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
    modelUp: '+Y',
    modelForward: '+X',
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

    }, undefined, (error) => {
        console.error("Error loading tiger model:", error);
    });

    window.addEventListener('resize', onWindowResize, false);
    document.addEventListener('mousemove', onDocumentMouseMove, false);

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
            if (tiger) tiger.material.color.set(v);
        });

    gui.add(params, 'walkSpeed', 0, 10, 0.1)
        .name('Walk Speed')
        .onChange((v) => { params.walkSpeed = v; });

    gui.add(params, 'pauseWalk')
        .name('Pause Walk');

    gui.add(params, 'rotationSpeed', 0, 2, 0.01)
        .name('Rotation Speed');

    gui.add(params, 'explode', 0, 1, 0.01)
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

    const orientFolder = gui.addFolder('Orientation');
    orientFolder.add(params, 'modelUp', ['+X','-X','+Y','-Y','+Z','-Z'])
        .name('Model Up')
        .onFinishChange(() => rebuildPointCloud(mergedGeometry));
    orientFolder.add(params, 'modelForward', ['+X','-X','+Y','-Y','+Z','-Z'])
        .name('Model Forward')
        .onFinishChange(() => rebuildPointCloud(mergedGeometry));

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

function onDocumentMouseMove(event) {
    event.preventDefault();

    if (!tiger) return;

    const mouse = new THREE.Vector2();
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);
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
