import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeBufferGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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

        const merged = mergeBufferGeometries(geometries, false);
        merged.computeBoundingBox();
        const box = merged.boundingBox;
        const size = new THREE.Vector3();
        box.getSize(size);
        const center = new THREE.Vector3();
        box.getCenter(center);
        // Center geometry at origin for easy framing/controls
        merged.translate(-center.x, -center.y, -center.z);

        const maxDim = Math.max(size.x, size.y, size.z);
        // Thinner points
        const pointSize = Math.max(maxDim * 0.0015, 0.0025);
        const material = new THREE.PointsMaterial({
            color: 0xff8800,
            size: pointSize,
            sizeAttenuation: true
        });

        tiger = new THREE.Points(merged, material);
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
        wobbleIntensity = Math.max(maxDim * 0.004, pointSize * 0.75);
        hoverRadius = Math.max(maxDim * 0.06, pointSize * 6);

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
        // Formation animation to converge from far away to original
        const posAttr = tiger.geometry.getAttribute('position');
        const arr = posAttr.array;
        if (!formationDone && startVertices) {
            const t = Math.min(1, (performance.now() - formationStart) / formationDuration);
            // easeOutCubic
            const e = 1 - Math.pow(1 - t, 3);
            for (let i = 0; i < arr.length; i += 3) {
                const sx = startVertices[i];
                const sy = startVertices[i + 1];
                const sz = startVertices[i + 2];
                const ox = originalVertices[i];
                const oy = originalVertices[i + 1];
                const oz = originalVertices[i + 2];
                const bx = sx + (ox - sx) * e;
                const by = sy + (oy - sy) * e;
                const bz = sz + (oz - sz) * e;
                arr[i] = bx;
                arr[i + 1] = by;
                arr[i + 2] = bz;
            }
            posAttr.needsUpdate = true;
            if (t >= 1) formationDone = true;
        }

        // Localized wobble around hover point (after formation)
        if (formationDone) {
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
                    const dx = ox - hx;
                    const dy = oy - hy;
                    const dz = oz - hz;
                    const d2 = dx * dx + dy * dy + dz * dz;
                    if (d2 < r2) {
                        const d = Math.sqrt(d2);
                        const falloff = 1 - d / hoverRadius; // 0..1
                        const amp = wobbleIntensity * falloff * falloff;
                        arr[i] = ox + (Math.random() - 0.5) * amp;
                        arr[i + 1] = oy + (Math.random() - 0.5) * amp;
                        arr[i + 2] = oz + (Math.random() - 0.5) * amp;
                        updated = true;
                    } else {
                        // Relax back to original
                        arr[i] += (originalVertices[i] - arr[i]) * Math.min(1, dt * 10);
                        arr[i + 1] += (originalVertices[i + 1] - arr[i + 1]) * Math.min(1, dt * 10);
                        arr[i + 2] += (originalVertices[i + 2] - arr[i + 2]) * Math.min(1, dt * 10);
                        updated = true;
                    }
                }
            } else {
                // No hover: relax all back to original smoothly
                for (let i = 0; i < arr.length; i++) {
                    arr[i] += (originalVertices[i] - arr[i]) * Math.min(1, dt * 10);
                }
                updated = true;
            }
            if (updated) posAttr.needsUpdate = true;
        }
    }

    // Walking animation for the whole group
    if (tigerGroup) {
        if (walkRange === 0) {
            // Initialize based on camera distance
            const z = camera.position.z;
            walkRange = z * 0.6; // stays in view
            walkSpeed = walkRange / 8; // cross in ~8s
        }
        tigerGroup.position.x += walkDirection * walkSpeed * dt;
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

    if (controls) controls.update();

    renderer.render(scene, camera);
}

function onDocumentMouseMove(event) {
    event.preventDefault();

    if (!tiger) return;

    const mouse = new THREE.Vector2();
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);
    // Tune hit test size relative to point size
    raycaster.params.Points.threshold = tiger && tiger.material && tiger.material.size
        ? tiger.material.size * 1.5
        : 0.1;

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
