import { useEffect, useRef, useState } from "react";
import { ParticleOrb } from "./ParticleOrb.js";

/**
 * The thinking orb, in real 3D.
 *
 * The SVG orb it replaces was doing vertex work on the CPU and writing the
 * result into several hundred DOM nodes every frame — fine at 300 points, the
 * whole frame budget at 4000. Here the sphere lives in a buffer and the motion
 * is a vertex shader, so the particle count stops being a performance decision
 * and becomes a design one.
 *
 * Three things keep it honest as an interface element rather than a demo:
 *
 *  - **It is lazy.** Three.js is a large dependency and this is one small
 *    ornament, so it is imported only once the orb is actually on screen. The
 *    SVG orb renders in the meantime and stays permanently if WebGL is
 *    unavailable or the import fails — nobody gets an empty box.
 *  - **It respects the machine.** The renderer is capped at 2× pixel ratio,
 *    the loop stops when the tab is hidden, and `prefers-reduced-motion`
 *    settles it to a slow drift instead of a churn.
 *  - **It answers to state.** `active` is the agent working; the sphere tightens
 *    and quickens. Idle, it breathes. The colour comes from the same aurora
 *    tokens the rest of the interface uses, so it belongs to the page.
 */

export interface Orb3DProps {
  size?: number;
  active?: boolean;
  count?: number;
  /** Aurora hues, as the rest of the interface knows them. */
  tint?: [string, string];
}

export function Orb3D({
  size = 72,
  active = true,
  count = 2600,
  tint = ["#8b7bf7", "#38e8c8"],
}: Orb3DProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(false);

  // Kept in refs so the animation reads the current value without the effect
  // tearing down and rebuilding the scene on every prop change.
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !supportsWebGL()) return;

    let disposed = false;
    let stop: (() => void) | undefined;

    void (async () => {
      let THREE: typeof import("three");
      try {
        THREE = await import("three");
      } catch {
        return; // the SVG orb stays; nothing to report
      }
      if (disposed || !hostRef.current) return;

      const reduced =
        typeof matchMedia === "function" &&
        matchMedia("(prefers-reduced-motion: reduce)").matches;

      const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(size, size, false);
      renderer.setClearColor(0x000000, 0);
      renderer.domElement.style.display = "block";
      hostRef.current.append(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
      camera.position.z = 3.05;

      // A Fibonacci sphere: the one distribution that looks even from every
      // angle, which matters because the thing is always turning.
      const positions = new Float32Array(count * 3);
      const seeds = new Float32Array(count);
      const golden = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < count; i++) {
        const y = 1 - (i / Math.max(1, count - 1)) * 2;
        const radius = Math.sqrt(Math.max(0, 1 - y * y));
        const theta = golden * i;
        positions[i * 3] = Math.cos(theta) * radius;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = Math.sin(theta) * radius;
        seeds[i] = Math.random();
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("seed", new THREE.BufferAttribute(seeds, 1));

      const uniforms = {
        uTime: { value: 0 },
        uActive: { value: active ? 1 : 0 },
        uSize: { value: size * Math.min(window.devicePixelRatio, 2) },
        uCold: { value: new THREE.Color(tint[0]) },
        uWarm: { value: new THREE.Color(tint[1]) },
      };

      const material = new THREE.ShaderMaterial({
        uniforms,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
      });

      const points = new THREE.Points(geometry, material);
      scene.add(points);

      setLive(true);

      let frame = 0;
      let last = performance.now();
      let time = 0;
      let energy = active ? 1 : 0;

      const tick = (now: number) => {
        frame = requestAnimationFrame(tick);
        const delta = Math.min(0.05, (now - last) / 1000);
        last = now;

        // Eased rather than switched: the orb should settle and wake, not jump.
        const target = activeRef.current ? 1 : 0;
        energy += (target - energy) * Math.min(1, delta * 2.5);

        const speed = reduced ? 0.12 : 0.34 + energy * 0.5;
        time += delta * speed;
        uniforms.uTime.value = time;
        uniforms.uActive.value = energy;

        points.rotation.y = time * 0.62;
        points.rotation.x = Math.sin(time * 0.35) * 0.22;

        renderer.render(scene, camera);
      };
      frame = requestAnimationFrame(tick);

      // A hidden tab should not spin the GPU.
      const onVisibility = () => {
        cancelAnimationFrame(frame);
        if (!document.hidden) {
          last = performance.now();
          frame = requestAnimationFrame(tick);
        }
      };
      document.addEventListener("visibilitychange", onVisibility);

      stop = () => {
        cancelAnimationFrame(frame);
        document.removeEventListener("visibilitychange", onVisibility);
        geometry.dispose();
        material.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      };
    })();

    return () => {
      disposed = true;
      stop?.();
      setLive(false);
    };
    // Rebuilt only when the geometry itself would change.
  }, [size, count, tint[0], tint[1]]);

  return (
    <span className="orb3d" style={{ width: size, height: size }}>
      <div ref={hostRef} className="orb3d-canvas" aria-hidden="true" />
      {!live && <ParticleOrb size={size} active={active} count={Math.min(count, 420)} />}
    </span>
  );
}

/**
 * Displacement is three sine layers rather than a noise texture: it costs
 * nothing to upload, reads as organic at this scale, and the frequencies can
 * be tuned by eye.
 */
const VERTEX = /* glsl */ `
  attribute float seed;
  uniform float uTime;
  uniform float uActive;
  uniform float uSize;
  varying float vDepth;
  varying float vSeed;

  void main() {
    vec3 p = position;
    float t = uTime;

    float wave =
      sin(p.x * 3.1 + t * 1.6) * 0.5 +
      sin(p.y * 4.3 - t * 1.1) * 0.3 +
      sin(p.z * 2.7 + t * 1.9) * 0.2;

    // Working: tighter and busier. Idle: a slow, wide breath.
    float amplitude = mix(0.055, 0.16, uActive);
    float breath = 1.0 + sin(t * 0.9) * mix(0.03, 0.06, uActive);

    p *= breath + wave * amplitude;
    p += normalize(p) * (seed - 0.5) * 0.04;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vDepth = clamp((mv.z + 3.0) / 2.2, 0.0, 1.0);
    vSeed = seed;

    gl_Position = projectionMatrix * mv;
    gl_PointSize = (uSize * (0.011 + seed * 0.009)) / -mv.z;
  }
`;

/**
 * Round, soft points. A square particle at this size reads as a glitch, and
 * the far side of the sphere is dimmed so the form stays legible.
 */
const FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform vec3 uCold;
  uniform vec3 uWarm;
  uniform float uActive;
  varying float vDepth;
  varying float vSeed;

  void main() {
    vec2 offset = gl_PointCoord - vec2(0.5);
    float d = length(offset);
    if (d > 0.5) discard;

    float falloff = smoothstep(0.5, 0.06, d);
    vec3 tint = mix(uCold, uWarm, clamp(vSeed * 0.7 + vDepth * 0.5, 0.0, 1.0));
    float alpha = falloff * mix(0.30, 0.70, vDepth) * mix(0.75, 1.0, uActive);

    gl_FragColor = vec4(tint, alpha);
  }
`;

/** One probe, cached: a failed context is expensive to ask for repeatedly. */
let webgl: boolean | null = null;
function supportsWebGL(): boolean {
  if (webgl !== null) return webgl;
  try {
    const canvas = document.createElement("canvas");
    webgl = Boolean(
      canvas.getContext("webgl2") ??
        canvas.getContext("webgl") ??
        canvas.getContext("experimental-webgl"),
    );
  } catch {
    webgl = false;
  }
  return webgl;
}
