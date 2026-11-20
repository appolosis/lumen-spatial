// Procedural immersive environments painted on a sky sphere.
// "Immersion" opens the environment as a portal in front of you, then wraps it all the way around.
import * as THREE from 'three';

export const ENVIRONMENTS = [
  { id: 'none', name: 'Passthrough', colors: ['#59606e', '#1b1d22'], icon: '👁️' },
  { id: 'lake', name: 'Lake at Dusk', colors: ['#ffa25e', '#3b2d6b'], icon: '🌅' },
  { id: 'stars', name: 'Starfield', colors: ['#2a3576', '#03040a'], icon: '✨' },
  { id: 'nebula', name: 'Nebula', colors: ['#c04bd6', '#1a1440'], icon: '🌌' },
  { id: 'theater', name: 'Theater', colors: ['#33333a', '#050507'], icon: '🎭' },
];

const frag = /* glsl */`
precision highp float;
varying vec3 vDir;
uniform float env;
uniform float time;
uniform float immersion;
uniform vec3 front;

float hash(vec3 p){ p = fract(p*0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float noise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x), mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x), mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y), f.z);
}
float fbm(vec3 p){ float a = 0.5, s = 0.0; for(int i=0;i<5;i++){ s += a*noise(p); p *= 2.03; a *= 0.5; } return s; }
float stars(vec3 d, float density, float thresh){
  vec3 p = d*density; vec3 i = floor(p); vec3 f = fract(p) - 0.5;
  float h = hash(i);
  vec3 o = vec3(hash(i+1.3), hash(i+2.7), hash(i+5.1)) - 0.5;
  float dist = length(f - o*0.6);
  float tw = 0.65 + 0.35*sin(time*1.7 + h*80.0);
  return step(thresh, h) * smoothstep(0.2, 0.0, dist) * tw * (h - thresh)/(1.0 - thresh);
}

const vec3 sunDir = vec3(0.287, 0.057, -0.956);
vec3 duskSky(vec3 d){
  float y = max(d.y, 0.0);
  vec3 c = mix(vec3(1.0,0.55,0.30), vec3(0.55,0.30,0.52), smoothstep(0.0, 0.2, y));
  c = mix(c, vec3(0.07,0.09,0.27), smoothstep(0.15, 0.75, y));
  float s = max(dot(d, sunDir), 0.0);
  c += vec3(1.0,0.78,0.5)*pow(s, 400.0)*3.0 + vec3(1.0,0.5,0.25)*pow(s, 10.0)*0.35;
  float cl = fbm(vec3(d.xz/(d.y+0.1)*1.3, time*0.01));
  c = mix(c, c*0.55 + vec3(0.32,0.16,0.24), smoothstep(0.55, 0.8, cl)*smoothstep(0.0, 0.25, y)*0.75);
  c += stars(d, 90.0, 0.975)*smoothstep(0.35, 0.85, y)*0.7;
  return c;
}
float hills(vec3 d){ float a = atan(d.x, d.z); float h = fbm(vec3(a*2.2, 1.7, 0.0)); return 0.008 + 0.09*h*h; }

void main(){
  vec3 d = normalize(vDir);
  vec3 c = vec3(0.0);
  if (env < 1.5) {               // lake at dusk
    if (d.y >= 0.0) {
      c = duskSky(d);
      float hh = hills(d);
      c = mix(c, vec3(0.06,0.045,0.09), smoothstep(hh+0.003, hh-0.003, d.y));
    } else {
      float depth = -d.y;
      vec2 wp = d.xz/(depth+0.02);
      float rip = noise(vec3(wp*3.0, time*0.4)) - 0.5;
      vec3 r = normalize(vec3(d.x + rip*0.03*depth*4.0, depth, d.z));
      c = duskSky(r)*vec3(0.55,0.6,0.78);
      c = mix(c, vec3(0.04,0.035,0.07), 0.6*smoothstep(hills(d)+0.004, hills(d)-0.004, depth + rip*0.01));
      c = mix(c, vec3(0.02,0.02,0.05), smoothstep(0.05, 0.7, depth)*0.7);
    }
  } else if (env < 2.5) {        // starfield
    c = mix(vec3(0.02,0.025,0.06), vec3(0.0,0.0,0.015), smoothstep(-0.2, 0.9, d.y));
    vec3 axis = normalize(vec3(0.3,1.0,0.2));
    float band = exp(-pow(dot(d, axis), 2.0)*14.0);
    c += vec3(0.22,0.22,0.34)*band*fbm(d*7.0)*1.2;
    c += stars(d, 90.0, 0.965) + stars(d, 160.0, 0.985 - band*0.03)*0.7;
  } else if (env < 3.5) {        // nebula
    c = vec3(0.01,0.008,0.03);
    float n = fbm(d*2.4 + vec3(0.0, 0.0, time*0.004));
    float n2 = fbm(d*4.8 + 3.1);
    c += vec3(0.65,0.18,0.85)*pow(n, 3.0)*1.9 + vec3(0.1,0.42,0.95)*pow(n2, 4.0)*1.8;
    c += stars(d, 90.0, 0.97)*1.2 + stars(d, 150.0, 0.985)*0.5;
  } else {                       // theater
    c = vec3(0.012,0.012,0.015);
    c += vec3(0.05,0.05,0.06)*smoothstep(-0.1, -0.9, d.y);
    c += vec3(0.03,0.03,0.045)*pow(max(dot(d, front), 0.0), 6.0);
  }
  float cosT = 1.0 - immersion*2.3;
  float a = immersion > 0.995 ? 1.0 : smoothstep(cosT - 0.22, cosT + 0.06, dot(d, front));
  gl_FragColor = vec4(c, a*clamp(immersion*5.0, 0.0, 1.0));
}`;

const vert = /* glsl */`
varying vec3 vDir;
void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export function createSky() {
  const uniforms = {
    env: { value: 1 }, time: { value: 0 }, immersion: { value: 0 },
    front: { value: new THREE.Vector3(0, 0, -1) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, vertexShader: vert, fragmentShader: frag,
    side: THREE.BackSide, transparent: true, depthWrite: false, depthTest: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(50, 64, 32), mat);
  mesh.renderOrder = -100;
  mesh.frustumCulled = false;
  let target = 0;
  return {
    mesh,
    set(envIndex, immersion, frontDir) {
      if (envIndex > 0) uniforms.env.value = envIndex;
      target = envIndex === 0 ? 0 : immersion;
      if (frontDir) uniforms.front.value.copy(frontDir).setY(0).normalize();
    },
    update(t, dt) {
      uniforms.time.value = t;
      const cur = uniforms.immersion.value;
      uniforms.immersion.value = cur + (target - cur) * Math.min(1, dt * 4);
      if (Math.abs(target - uniforms.immersion.value) < 0.002) uniforms.immersion.value = target;
      mesh.visible = uniforms.immersion.value > 0.001;
    },
  };
}
