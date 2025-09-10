import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

let scene, camera, renderer, tiger;
let originalVertices = [];
const wobbleIntensity = 0.1;

function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111111); // Back to dark background

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 5;

    renderer = new THREE.WebGLRenderer();
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    const loader = new GLTFLoader();
    loader.load('tiger.glb', (gltf) => {
        console.log("Tiger model loaded successfully!");

        gltf.scene.traverse((object) => {
            if (object.isMesh) {
                const material = new THREE.PointsMaterial({
                    color: 0xff8800,
                    size: 0.02
                });

                tiger = new THREE.Points(object.geometry, material);
                tiger.position.x = -10; // Start off-screen
                scene.add(tiger);

                // Store original vertices for wobble effect
                originalVertices = Array.from(tiger.geometry.attributes.position.array);
            }
        });

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

let walkDirection = 1;
const walkSpeed = 0.05;

function animate() {
    requestAnimationFrame(animate);

    if (tiger) {
        tiger.position.x += walkSpeed * walkDirection;
        if (tiger.position.x > 10 || tiger.position.x < -10) {
            walkDirection *= -1;
            tiger.rotation.y += Math.PI;
        }
    }

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
    raycaster.params.Points.threshold = 0.1; // Adjust this for sensitivity

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
