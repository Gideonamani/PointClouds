import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeBufferGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

let scene, camera, renderer, controls, tiger;
let originalVertices = [];
let wobbleIntensity = 0.1; // scaled after load based on model size

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
        const pointSize = Math.max(maxDim * 0.006, 0.01); // scale points to model size
        const material = new THREE.PointsMaterial({
            color: 0xff8800,
            size: pointSize,
            sizeAttenuation: true
        });

        tiger = new THREE.Points(merged, material);
        scene.add(tiger);

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

        // Store original vertices for wobble effect
        originalVertices = Array.from(tiger.geometry.attributes.position.array);

        // Scale wobble and raycast threshold relative to model size
        wobbleIntensity = Math.max(maxDim * 0.01, pointSize * 0.5);

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

// We’ll keep the model in place and slowly rotate for clarity

function animate() {
    requestAnimationFrame(animate);

    if (tiger) {
        tiger.rotation.y += 0.005;
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

    const positions = tiger.geometry.attributes.position.array;

    if (intersects.length > 0) {
        // Wobble effect
        for (let i = 0; i < positions.length; i += 3) {
            const x = originalVertices[i];
            const y = originalVertices[i + 1];
            const z = originalVertices[i + 2];

            positions[i] = x + (Math.random() - 0.5) * wobbleIntensity;
            positions[i + 1] = y + (Math.random() - 0.5) * wobbleIntensity;
            positions[i + 2] = z + (Math.random() - 0.5) * wobbleIntensity;
        }
        tiger.geometry.attributes.position.needsUpdate = true;
    } else {
        // Return to original state
        for (let i = 0; i < positions.length; i++) {
            positions[i] = originalVertices[i];
        }
        tiger.geometry.attributes.position.needsUpdate = true;
    }
}

init();
