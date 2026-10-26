/**
 * scene.js — Cinematic Ray-Marched Black Hole + Interactive Emitter
 * - Procedural GLSL raymarching with GR lensing, volumetric disk, HDR bloom
 * - Bright visible rays with adaptive coloring by fate
 * - Glowing pulsing emitter always aimed at the black hole
 * - Real-time client-side RK4 preview while dragging
 * - Full mouse/keyboard interaction: left-drag emitter, right-drag orbit, double-click place
 */
'use strict';

const Scene = (() => {
  let renderer, scene, camera, composer;
  let animFrame;
  let heatmapCtx = null, heatmapCanvas = null, heatmapVisible = false;
  let onSourceMovedCallback = null;

  const objects = {
    raymarchMesh: null,
    emitter:      null,   // group: sphere + halo + direction arrow
    previewLines: [],     // client-side RK4 preview segments
    rayLines:     [],
    rayColors:    [],
  };

  // ── Configurable visual params (driven by sliders) ──────────────────────
  let cfg = {
    rs: 2.0,
    r_photon: 3.0,
    mass: 1.0,
    diskBrightness: 0.75,
    showPhotonSphere: true,
    showHotSpots: true,
    showTrails: true,
    rayBrightness: 2.0,
    rayThickness: 2,
    trailLength: 4000,
    sourceSize: 1.0,
    sourceGlow: 1.0,
    followSource: false,
    continuousEmit: false,
    autoFaceBH: true,
    lockDrag: false,
  };

  const MAX_POINTS_PER_RAY = 6000;

  // ── GLSL Raymarching Fragment Shader ────────────────────────────────────
  const fragmentShaderSource = `
    uniform float time;
    uniform float rs;
    uniform float diskBrightness;
    uniform float showPhotonRing;
    uniform float showTurbulence;

    varying vec3 vWorldPosition;

    float hash(float n){return fract(sin(n)*43758.5453123);}
    float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123);}
    float hash(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453123);}

    float noise(vec3 x){
      vec3 p=floor(x); vec3 f=fract(x); f=f*f*(3.0-2.0*f);
      float n=p.x+p.y*157.0+113.0*p.z;
      return mix(mix(mix(hash(n),hash(n+1.0),f.x),mix(hash(n+157.0),hash(n+158.0),f.x),f.y),
                 mix(mix(hash(n+113.0),hash(n+114.0),f.x),mix(hash(n+270.0),hash(n+271.0),f.x),f.y),f.z);
    }
    float noise(vec2 p){
      vec2 i=floor(p); vec2 f=fract(p); f=f*f*(3.0-2.0*f);
      return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
    }
    float fbm(vec3 p){float v=0.0,a=0.5;vec3 s=vec3(100);for(int i=0;i<4;i++){v+=a*noise(p);p=p*2.0+s;a*=0.5;}return v;}
    float fbm(vec2 p){float v=0.0,a=0.5;for(int i=0;i<4;i++){v+=a*noise(p);p*=2.0;a*=0.5;}return v;}

    vec3 renderBackground(vec3 dir, vec3 origDir){
      float n=fbm(dir*2.5+vec3(time*0.015));
      float n2=fbm(dir*4.5-vec3(time*0.008));
      vec3 bg=vec3(0.035,0.008,0.075)*smoothstep(0.12,0.88,n)
             +vec3(0.08,0.028,0.008)*smoothstep(0.22,0.92,n2);
      float mw=exp(-6.5*pow(dot(dir,vec3(0.38,0.88,0.12)),2.0));
      bg+=vec3(0.05,0.03,0.09)*mw+vec3(0.09,0.05,0.025)*fbm(dir*6.5)*mw;

      // High density star field with gravitational lensing streaking
      vec3 sg=floor(dir*380.0);
      float sh=hash(sg);
      if(sh>0.982){
        float dToS=length(dir-normalize((sg+0.5)/380.0));
        float twinkle=0.48+0.52*sin(time*3.2+sh*120.0);
        float si=smoothstep(0.0028*(0.35+0.65*hash(sg+vec3(1))),0.0,dToS)*twinkle;
        
        // Doppler redshift/blueshift of background stars due to strong gravity bending
        float deflection = 1.0 - dot(dir, origDir);
        vec3 sc = vec3(1.0);
        if(deflection > 0.04) {
          sc = mix(vec3(1.0), vec3(1.4, 0.45, 0.18), clamp(deflection * 1.8, 0.0, 0.85));
        } else {
          if(sh>0.997)sc=vec3(0.6,0.85,1.25);
          else if(sh>0.994)sc=vec3(1.2,0.98,0.68);
          else if(sh>0.991)sc=vec3(1.2,0.52,0.42);
        }
        bg+=sc*si*16.0;
      }
      return bg;
    }

    void main(){
      vec3 p=cameraPosition;
      vec3 origV=normalize(vWorldPosition-cameraPosition);
      vec3 v=origV;
      float accOpacity=1.0;
      vec3 accColor=vec3(0.0);
      float maxDist=180.0;

      for(int i=0;i<220;i++){
        float r2=dot(p,p); float r=sqrt(r2);
        if(r<rs*1.001){accOpacity=0.0;break;}
        if(r>maxDist)break;
        float dt=max(0.012,min(0.3,0.045*(r-rs*0.95)));
        vec3 J=cross(p,v); float h2=dot(J,J);
        vec3 a=-1.5*rs*h2*p/(r2*r2*r);
        v+=a*dt; v=normalize(v); p+=v*dt;

        // Volumetric accretion disk plane crossing & intersection
        float rd=length(p.xz);
        // Realistic profile: thick near center, tapering off towards edges
        float dthk = 0.45 * exp(-0.06 * rd) * (1.0 - exp(-(rd - rs * 2.8)));
        
        if(rd>rs*2.8&&rd<rs*16.0&&abs(p.y)<dthk*3.2){
          float hf=exp(-0.5*(p.y/dthk)*(p.y/dthk));
          float omega=1.8/pow(rd,1.5);
          float theta=atan(p.z,p.x);
          float dens=1.8;
          
          if(showTurbulence>0.5){
            // Turbulent noise, spiral streaks, and swirling plasma
            vec2 sw=vec2(rd*0.48-time*0.12,theta-time*omega+0.9*rd);
            float n1 = fbm(sw*3.2);
            float n2 = fbm(sw*6.5 + vec2(time*0.15, -time*0.08));
            float noiseVal = n1*0.7 + n2*0.3;
            float streak = smoothstep(0.18, 0.82, noiseVal);
            
            // Swirling plasma filaments
            float filament = sin(theta * 6.0 - time * omega * 2.5 + rd * 2.5) * 0.5 + 0.5;
            dens*=hf*(streak*0.8 + filament*0.2);
          } else { 
            dens*=hf*0.55; 
          }
          dens+=0.08*hf;
          
          if(dens>0.0){
            float t=clamp((rd-rs*2.8)/(rs*13.2),0.0,1.0);
            vec3 dc;
            // Hot color gradient: softened cream/banana yellow (inner), golden yellow, orange, deep red (outer)
            if(t < 0.12) {
              dc = mix(vec3(4.2, 3.6, 1.1), vec3(3.0, 2.1, 0.5), t / 0.12);
            } else if(t < 0.38) {
              dc = mix(vec3(3.0, 2.1, 0.5), vec3(1.8, 0.8, 0.05), (t - 0.12) / 0.26);
            } else if(t < 0.72) {
              dc = mix(vec3(1.8, 0.8, 0.05), vec3(0.8, 0.08, 0.008), (t - 0.38) / 0.34);
            } else {
              dc = mix(vec3(0.8, 0.08, 0.008), vec3(0.0), (t - 0.72) / 0.28);
            }
            
            // Keplerian orbital velocity Doppler beaming
            float os=sqrt(rs/(2.0*rd));
            vec3 dv=os*normalize(vec3(-p.z,0,p.x));
            float ct=dot(dv,v);
            float gm=1.0/sqrt(1.0-os*os+0.0001);
            float D=1.0/(gm*(1.0-os*ct));
            
            // Doppler beaming: approaching side brighter/bluish-white, receding side darker/reddish
            float D_clamped = clamp(D, 0.5, 1.45); // gently clamped to avoid intense glare
            dc *= pow(D_clamped, 2.2) * diskBrightness;
            
            if (D > 1.0) {
              dc = mix(dc, vec3(0.85, 1.0, 1.45) * length(dc) * 0.6, clamp((D - 1.0) * 0.35, 0.0, 0.35));
            } else {
              dc = mix(dc, vec3(1.3, 0.12, 0.02) * length(dc) * 0.7, clamp((1.0 - D) * 0.45, 0.0, 0.55));
            }
            
            float od=dens*dt*2.5; float al=1.0-exp(-od);
            accColor+=accOpacity*dc*al; accOpacity*=(1.0-al);
            if(accOpacity<0.01){accOpacity=0.0;break;}
          }
        }

        // Photon sphere ring
        if(showPhotonRing>0.5){
          float pd=abs(r-rs*1.5);
          if(pd<0.09*rs){
            // Lorentzian profile for a very sharp photon ring
            float pg = 1.0 / (1.0 + 380.0 * (pd/rs) * (pd/rs));
            float pulse=1.0+0.06*sin(time*8.0+p.x*2.0);
            vec3 pc=vec3(1.9,1.1,0.5)*pg*pulse*diskBrightness;
            float od=1.0*pg*dt; float al=1.0-exp(-od);
            accColor+=accOpacity*pc*al; accOpacity*=(1.0-al);
          }
        }

        // Horizon edge gravitational glow
        float hz=0.025*exp(-3.5*(r-rs)/rs)*(1.0+0.25*noise(p*2.2-time*0.15));
        if(hz>0.0&&r>rs){
          vec3 hc=vec3(1.1,0.22,0.04)*diskBrightness;
          float od=hz*dt; float al=1.0-exp(-od);
          accColor+=accOpacity*hc*al; accOpacity*=(1.0-al);
        }

        // Tiny floating plasma/star particles near accretion disk
        vec3 dc2=floor(p*2.2); float dh=hash(dc2);
        if(dh>0.9948&&r>rs*1.8&&r<rs*14.0){
          vec3 cc=(dc2+0.5)/2.2;
          cc.xz+=0.08*vec2(sin(time*0.2+dh*6.0),cos(time*0.25+dh*3.0));
          cc.y+=0.04*sin(time*0.35+dh*9.0);
          float dp2=length(p-cc);
          if(dp2<0.085){
            float gw=smoothstep(0.085,0.0,dp2);
            vec3 pc2=mix(vec3(1.6,0.45,0.1),vec3(1.8,1.6,1.1),exp(-0.08*r));
            accColor+=accOpacity*pc2*gw*0.42*diskBrightness;
          }
        }
        
        if(accOpacity<0.01){accOpacity=0.0;break;}
      }
      if(accOpacity>0.0) accColor+=accOpacity*renderBackground(v, origV);
      gl_FragColor=vec4(accColor,1.0);
    }
  `;

  // ── Ray color by fate / distance ────────────────────────────────────────
  function rayColorForStatus(status) {
    switch (status) {
      case 'ABSORBED': return new THREE.Color(0.85, 0.04, 0.02);
      case 'ORBITING': return new THREE.Color(1.0, 0.22, 0.15);
      case 'ESCAPED':  return new THREE.Color(1.0, 0.18, 0.18);
      default:         return new THREE.Color(1.0, 0.12, 0.12); // ACTIVE: vibrant glowing laser red
    }
  }

  // ── Client-side RK4 geodesic solver for preview ─────────────────────────
  function traceGeodesic3D(origin, dir, rs, steps = 220) {
    const pts = [origin.clone()];
    let p = origin.clone();
    let v = dir.clone().normalize();
    const dt = 0.18;
    for (let i = 0; i < steps; i++) {
      const r2 = p.dot(p);
      const r  = Math.sqrt(r2);
      if (r < rs * 1.05 || r > 160) break;
      const J  = new THREE.Vector3().crossVectors(p, v);
      const h2 = J.dot(J);
      const fac = -1.5 * rs * h2 / (r2 * r2 * r);
      const a   = p.clone().multiplyScalar(fac);
      v.addScaledVector(a, dt);
      v.normalize();
      p.addScaledVector(v, dt);
      pts.push(p.clone());
    }
    return pts;
  }

  // ── Draw/update client-side preview lines ───────────────────────────────
  function updatePreview(emitterPos, spreadRays) {
    clearPreview();
    if (!spreadRays || spreadRays.length === 0) return;
    for (const dir of spreadRays) {
      const pts = traceGeodesic3D(emitterPos, dir, cfg.rs);
      const positions = new Float32Array(pts.length * 3);
      pts.forEach((p, i) => { positions[i*3]=p.x; positions[i*3+1]=p.y; positions[i*3+2]=p.z; });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.LineBasicMaterial({
        color: 0xff2233, // vibrant glowing red preview line
        transparent: true,
        opacity: 0.65,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      });
      const line = new THREE.Line(geo, mat);
      scene.add(line);
      objects.previewLines.push(line);
    }
  }

  function clearPreview() {
    objects.previewLines.forEach(l => { scene.remove(l); l.geometry.dispose(); l.material.dispose(); });
    objects.previewLines = [];
  }

  // Fan of direction vectors toward the black hole from a given position
  function getFanDirs(pos, count = 40, spread = 0.35) {
    const towardBH = pos.clone().negate().normalize();
    const up_ref = new THREE.Vector3(0, 1, 0);
    let right = new THREE.Vector3().crossVectors(towardBH, up_ref).normalize();
    if (right.lengthSq() < 0.001) {
      right = new THREE.Vector3().crossVectors(towardBH, new THREE.Vector3(0, 0, 1)).normalize();
    }
    const dirs = [];
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0 : (i / (count - 1) - 0.5);
      const angle = t * spread;
      const d = towardBH.clone()
        .addScaledVector(right, Math.sin(angle))
        .normalize();
      dirs.push(d);
    }
    return dirs;
  }

  // ── Emitter Positioning & Orientation Helpers ───────────────────────────
  function updateEmitterOrientation() {
    if (!objects.emitter) return;
    // Always strictly bound to face the black hole singularity at (0, 0, 0)
    objects.emitter.lookAt(0, 0, 0);
  }

  let sourceMovedTimer = null;
  function notifySourceMoved() {
    if (onSourceMovedCallback && objects.emitter) {
      const p = objects.emitter.position;
      const r = p.length();
      const theta = Math.atan2(p.x, p.z);
      const phi = Math.acos(Math.max(-1, Math.min(1, p.y / Math.max(0.001, r))));
      const yaw = THREE.MathUtils.radToDeg(theta);
      const pitch = 90 - THREE.MathUtils.radToDeg(phi);
      onSourceMovedCallback([p.x, p.y, p.z], yaw, pitch, r);
    }
  }

  function setEmitterPosition(x, y, z) {
    if (!objects.emitter) return;
    objects.emitter.position.set(x, y, z);
    updateEmitterOrientation();
    const fanDirs = getFanDirs(objects.emitter.position, 20, 0.5);
    updatePreview(objects.emitter.position, fanDirs);
    notifySourceMoved();
  }

  function setEmitterSpherical(dist_rs, yaw_deg, pitch_deg) {
    const rs = cfg.rs;
    const r = dist_rs * rs;
    const yawRad = THREE.MathUtils.degToRad(yaw_deg);
    const pitchRad = THREE.MathUtils.degToRad(pitch_deg);
    const x = r * Math.cos(pitchRad) * Math.sin(yawRad);
    const y = r * Math.sin(pitchRad);
    const z = r * Math.cos(pitchRad) * Math.cos(yawRad);
    setEmitterPosition(x, y, z);
  }

  function setEmitterPreset(preset) {
    const rs = cfg.rs;
    switch(preset) {
      case 'behind':
        // Directly behind black hole (Z < 0) for observing Einstein ring lensing
        setEmitterPosition(0, 0, -12 * rs);
        break;
      case 'disk':
        // On outer accretion disk boundary
        setEmitterPosition(10 * rs, 0, 0);
        break;
      case 'polar':
        // Directly above North pole
        setEmitterPosition(0, 14 * rs, 0.01);
        break;
      case 'equator':
        // Snap current position to equatorial plane (y = 0)
        if (objects.emitter) {
          setEmitterPosition(objects.emitter.position.x, 0, objects.emitter.position.z);
        }
        break;
      case 'reset':
      default:
        setEmitterPosition(10 * rs, 0, 0);
        break;
    }
  }

  function setAutoFaceBH(v) {
    cfg.autoFaceBH = v;
    if (v) updateEmitterOrientation();
  }

  function setLockEmitterDrag(v) {
    cfg.lockDrag = v;
  }

  // ── Glowing emitter mesh ─────────────────────────────────────────────────
  function buildEmitter() {
    const group = new THREE.Group();
    group.position.set(15, 0, 0);

    // 1. Contrast Shield: Black semi-transparent sphere to block out the bright white accretion disk behind the reticle
    const shieldMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      depthTest: false
    });
    const shieldMesh = new THREE.Mesh(new THREE.SphereGeometry(0.48, 16, 16), shieldMat);
    shieldMesh.name = 'emitter-shield';
    group.add(shieldMesh);

    // 2. Central Core: Radiant luminous red sphere
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xff1122,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      depthTest: false
    });
    const coreMesh = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 16), coreMat);
    coreMesh.name = 'emitter-core';
    group.add(coreMesh);

    // 3. Three Gimbal Rings (horizontal, vertical-front, vertical-side)
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xff2233,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      depthTest: false,
      wireframe: true
    });
    
    const ring1 = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.015, 8, 32), ringMat);
    ring1.rotation.x = Math.PI / 2;
    group.add(ring1);

    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.015, 8, 32), ringMat);
    ring2.rotation.y = Math.PI / 2;
    group.add(ring2);

    const ring3 = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.015, 8, 32), ringMat);
    group.add(ring3);

    // 4. Outer square corner brackets (focus reticle style)
    const boxMat = new THREE.LineBasicMaterial({
      color: 0xff2233,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      depthTest: false
    });
    
    // Draw crosshair ticks
    const ticksGeo = new THREE.BufferGeometry();
    const ticksPts = [
      // Top tick
      new THREE.Vector3(0, 0.5, 0), new THREE.Vector3(0, 0.65, 0),
      // Bottom tick
      new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(0, -0.65, 0),
      // Left tick
      new THREE.Vector3(0, 0, -0.5), new THREE.Vector3(0, 0, -0.65),
      // Right tick
      new THREE.Vector3(0, 0, 0.5), new THREE.Vector3(0, 0, 0.65),
    ];
    ticksGeo.setFromPoints(ticksPts);
    const ticks = new THREE.LineSegments(ticksGeo, boxMat);
    group.add(ticks);

    // Direction arrow (thin cone pointing strictly along local -Z toward BH)
    const arrowMat = new THREE.MeshBasicMaterial({
      color: 0xff1122,
      transparent: true, opacity: 0.95,
      depthWrite: false, depthTest: false
    });
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.6, 12), arrowMat);
    cone.name = 'emitter-arrow';
    cone.rotation.x = -Math.PI / 2; // ConeGeometry points along +Y. Rotate by -PI/2 around X to point along -Z
    cone.position.set(0, 0, -0.6);
    group.add(cone);

    // Thin beam line pointing along local -Z toward BH
    const beamPts = [new THREE.Vector3(0, 0, -0.4), new THREE.Vector3(0, 0, -3.5)];
    const beamGeo = new THREE.BufferGeometry().setFromPoints(beamPts);
    const beamLine = new THREE.Line(beamGeo, new THREE.LineBasicMaterial({
      color: 0xff2233, transparent: true, opacity: 0.8,
      depthTest: false, depthWrite: false
    }));
    group.add(beamLine);

    group.userData = { halo1: ring1, halo2: ring2, coreMesh, ringMat, boxMat, arrowMat, beamLine, phase: 0 };
    return group;
  }

  // ── Camera / source orbit controls ──────────────────────────────────────
  function createOrbitControls(cam, domElem) {
    let isDragging     = false;
    let isRightDrag    = false;
    let isMiddleDrag   = false;
    let isEmitterDrag  = false;
    let prevX = 0, prevY = 0;
    const spherical = { r: 45, theta: 0, phi: Math.PI / 2 - 0.14 };
    const target    = new THREE.Vector3(0, 0, 0);
    const raycaster = new THREE.Raycaster();
    const mouse     = new THREE.Vector2();
    let   emitThrottle = 0;

    function update() {
      const sinPhi = Math.sin(spherical.phi);
      const cosPhi = Math.cos(spherical.phi);
      cam.position.set(
        target.x + spherical.r * sinPhi * Math.sin(spherical.theta),
        target.y + spherical.r * cosPhi,
        target.z + spherical.r * sinPhi * Math.cos(spherical.theta),
      );
      cam.lookAt(target);
    }

    function hitTestEmitter(ex, ey) {
      if (cfg.lockDrag) return false;
      if (!objects.emitter) return false;
      mouse.x =  (ex / window.innerWidth)  * 2 - 1;
      mouse.y = -(ey / window.innerHeight) * 2 + 1;
      raycaster.setFromCamera(mouse, cam);
      raycaster.params.Points.threshold = 0.5;
      const hits = raycaster.intersectObjects(objects.emitter.children, true);
      return hits.length > 0;
    }

    // Place emitter freely on a plane parallel to the camera
    function placeEmitterAt(ex, ey) {
      if (cfg.lockDrag) return;
      mouse.x =  (ex / window.innerWidth)  * 2 - 1;
      mouse.y = -(ey / window.innerHeight) * 2 + 1;
      raycaster.setFromCamera(mouse, cam);
      const planeNormal = new THREE.Vector3();
      cam.getWorldDirection(planeNormal);
      planeNormal.negate();
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, objects.emitter.position);
      const pt = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(plane, pt)) {
        setEmitterPosition(pt.x, pt.y, pt.z);
      }
    }

    function getSourceSpherical() {
      const p = objects.emitter.position;
      const r = p.length();
      return { r, theta: Math.atan2(p.x, p.z), phi: Math.acos(Math.max(-1, Math.min(1, p.y / r))) };
    }

    function fireThrottled() {
      const now = performance.now();
      if (now - emitThrottle < 80) return;
      emitThrottle = now;
      if (onSourceMovedCallback) {
        const p = objects.emitter.position;
        const sp = getSourceSpherical();
        const yaw   = THREE.MathUtils.radToDeg(sp.theta);
        const pitch = 90 - THREE.MathUtils.radToDeg(sp.phi);
        onSourceMovedCallback([p.x, p.y, p.z], yaw, pitch, sp.r);
      }
    }

    domElem.addEventListener('dblclick', e => {
      if (hitTestEmitter(e.clientX, e.clientY)) {
        // Double-click on emitter → reposition it
        placeEmitterAt(e.clientX, e.clientY);
        clearPreview();
        fireThrottled();
      } else {
        // Double-click on background → reset camera to default view
        spherical.r     = 45;
        spherical.theta = 0;
        spherical.phi   = Math.PI / 2 - 0.14;
        update();
      }
    });

    domElem.addEventListener('mousedown', e => {
      if (e.button === 0) {
        if (hitTestEmitter(e.clientX, e.clientY)) {
          isEmitterDrag = true;
          domElem.style.cursor = 'grabbing';
          prevX = e.clientX; prevY = e.clientY;
          return;
        }
        isDragging = true;
      }
      prevX = e.clientX; prevY = e.clientY;
    });

    window.addEventListener('mouseup', () => {
      if (isEmitterDrag) {
        clearPreview();
        fireThrottled();
        isEmitterDrag = false;
        domElem.style.cursor = '';
      }
      isDragging = false;
    });

    window.addEventListener('mousemove', e => {
      const dx = e.clientX - prevX;
      const dy = e.clientY - prevY;
      prevX = e.clientX; prevY = e.clientY;

      // Hover cursor for emitter
      if (!isEmitterDrag && !isDragging && hitTestEmitter(e.clientX, e.clientY)) {
        domElem.style.cursor = 'grab';
        updateEmitterHover(true);
      } else if (!isEmitterDrag) {
        if (domElem.style.cursor === 'grab') domElem.style.cursor = '';
        updateEmitterHover(false);
      }

      // Dragging emitter
      if (isEmitterDrag) {
        placeEmitterAt(e.clientX, e.clientY);
        if (cfg.continuousEmit) fireThrottled();
        return;
      }

      // Dragging camera (orbit)
      if (isDragging) {
        spherical.theta -= dx * 0.008;
        // Allow full top/bottom viewing by clamping phi closer to 0 and PI
        spherical.phi = Math.max(0.01, Math.min(Math.PI - 0.01, spherical.phi - dy * 0.008));
        update();
      }
    });

    domElem.addEventListener('wheel', e => {
      e.preventDefault(); // stop browser page-zoom / page-scroll
      // Normalize deltaY across mouse wheel (large steps) and trackpad (tiny steps)
      const zoomDelta = e.deltaY !== 0
        ? Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 50)
        : 0;
      if (zoomDelta !== 0) {
        spherical.r = Math.max(2, Math.min(600, spherical.r * (1 + zoomDelta * 0.012)));
      }
      // Swipe left/right on touchpad to orbit horizontally
      if (Math.abs(e.deltaX) > 0) {
        spherical.theta -= e.deltaX * 0.005;
      }
      update();
    }, { passive: false });

    domElem.addEventListener('contextmenu', e => e.preventDefault());

    // Keyboard: WASD/arrows fine-tune emitter, R resets camera
    window.addEventListener('keydown', e => {
      const key = e.key;
      if (key === 'r' || key === 'R') {
        spherical.r = 45; spherical.theta = 0; spherical.phi = Math.PI / 2 - 0.14;
        target.set(0, 0, 0); update();
        return;
      }
      if (!objects.emitter) return;
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
      const nudge = 0.5;
      let moved = false;
      if (key === 'ArrowLeft'  || key === 'a') { objects.emitter.position.addScaledVector(right, -nudge); moved = true; }
      if (key === 'ArrowRight' || key === 'd') { objects.emitter.position.addScaledVector(right, nudge); moved = true; }
      if (key === 'ArrowUp'    || key === 'w') { objects.emitter.position.addScaledVector(up, nudge); moved = true; }
      if (key === 'ArrowDown'  || key === 's') { objects.emitter.position.addScaledVector(up, -nudge); moved = true; }
      if (moved) {
        objects.emitter.lookAt(0, 0, 0);
        const fanDirs = getFanDirs(objects.emitter.position, 20, 0.5);
        updatePreview(objects.emitter.position, fanDirs);
        fireThrottled();
      }
    });

    update();
    return { update, spherical, target };
  }

  // ── Emitter hover scale ──────────────────────────────────────────────────
  function updateEmitterHover(hovering) {
    if (!objects.emitter) return;
    const t = hovering ? 1.45 : 1.0;
    objects.emitter.scale.lerp(new THREE.Vector3(t, t, t), 0.15);
  }

  // ── Heatmap overlay ──────────────────────────────────────────────────────
  function initHeatmap() {
    heatmapCanvas = document.getElementById('heatmap-canvas');
    if (!heatmapCanvas) return;
    heatmapCtx = heatmapCanvas.getContext('2d');
    heatmapCanvas.width = window.innerWidth;
    heatmapCanvas.height = window.innerHeight;
    window.addEventListener('resize', () => {
      heatmapCanvas.width = window.innerWidth;
      heatmapCanvas.height = window.innerHeight;
    });
  }

  function updateHeatmap() {
    if (!heatmapCtx || !heatmapVisible || !camera) return;
    const w = heatmapCanvas.width, h = heatmapCanvas.height;
    heatmapCtx.clearRect(0, 0, w, h);
    const bh = new THREE.Vector3().project(camera);
    const bhX = (bh.x + 1) / 2 * w, bhY = (1 - (bh.y + 1) / 2) * h;
    const rs2 = new THREE.Vector3(cfg.rs, 0, 0).project(camera);
    const rsP = Math.hypot((rs2.x + 1)/2*w - bhX, (1-(rs2.y+1)/2)*h - bhY);
    const outerR = Math.min(w,h)*0.52, innerR = Math.max(4, rsP * 0.6);
    const grad = heatmapCtx.createRadialGradient(bhX, bhY, innerR, bhX, bhY, outerR);
    grad.addColorStop(0.00, 'rgba(255,255,220,0.60)');
    grad.addColorStop(0.14, 'rgba(255, 60,  0,0.42)');
    grad.addColorStop(0.45, 'rgba(100,  0,180,0.18)');
    grad.addColorStop(1.00, 'rgba(  0,  0,  0,0.00)');
    heatmapCtx.fillStyle = grad;
    heatmapCtx.fillRect(0, 0, w, h);
  }

  // ── Source Radar & Position Console ──────────────────────────────────────
  let radarCanvas = null;
  let radarCtx = null;
  let isRadarDragging = false;

  function initSourceRadar() {
    radarCanvas = document.getElementById('source-radar-canvas');
    if (!radarCanvas) return;
    radarCtx = radarCanvas.getContext('2d');

    const handleRadarEvent = (e) => {
      if (!radarCanvas) return;
      const rect = radarCanvas.getBoundingClientRect();
      const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0].clientX);
      const clientY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0].clientY);
      if (clientX === undefined || clientY === undefined) return;
      
      const pxX = clientX - rect.left;
      const pxY = clientY - rect.top;
      const cx = radarCanvas.width / 2;
      const cy = radarCanvas.height / 2;
      const maxRadarR = 25.0 * cfg.rs;
      const scale = (cx - 8) / maxRadarR;

      const worldX = (pxX - cx) / scale;
      const worldZ = (pxY - cy) / scale;
      const currentY = objects.emitter ? objects.emitter.position.y : 0;
      setEmitterPosition(worldX, currentY, worldZ);
    };

    radarCanvas.addEventListener('mousedown', (e) => {
      isRadarDragging = true;
      handleRadarEvent(e);
    });

    window.addEventListener('mousemove', (e) => {
      if (isRadarDragging) handleRadarEvent(e);
    });

    window.addEventListener('mouseup', () => {
      if (isRadarDragging) isRadarDragging = false;
    });

    radarCanvas.addEventListener('touchstart', (e) => {
      isRadarDragging = true;
      handleRadarEvent(e);
      e.preventDefault();
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
      if (isRadarDragging) {
        handleRadarEvent(e);
        e.preventDefault();
      }
    }, { passive: false });

    window.addEventListener('touchend', () => {
      isRadarDragging = false;
    });

    // Preset buttons on the radar console
    document.querySelectorAll('.source-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = btn.getAttribute('data-preset');
        if (p) setEmitterPreset(p);
      });
    });
  }

  function drawSourceRadar() {
    if (!radarCtx || !radarCanvas || !objects.emitter) return;
    const w = radarCanvas.width;
    const h = radarCanvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const maxRadarR = 25.0 * cfg.rs;
    const scale = (cx - 8) / maxRadarR;

    radarCtx.clearRect(0, 0, w, h);

    // Save state for circular radar boundary
    radarCtx.save();
    radarCtx.beginPath();
    radarCtx.arc(cx, cy, cx - 1, 0, Math.PI * 2);
    radarCtx.clip();

    // Concentric orbital grid rings (5, 10, 15, 20 rs)
    const ringSteps = [5, 10, 15, 20];
    ringSteps.forEach(rsDist => {
      const r = rsDist * cfg.rs * scale;
      radarCtx.beginPath();
      radarCtx.arc(cx, cy, r, 0, Math.PI * 2);
      radarCtx.strokeStyle = 'rgba(0, 242, 254, 0.16)';
      radarCtx.lineWidth = 1;
      radarCtx.stroke();
    });

    // Crosshairs
    radarCtx.beginPath();
    radarCtx.moveTo(cx, 4); radarCtx.lineTo(cx, h - 4);
    radarCtx.moveTo(4, cy); radarCtx.lineTo(w - 4, cy);
    radarCtx.strokeStyle = 'rgba(0, 242, 254, 0.12)';
    radarCtx.stroke();

    // Accretion disk band: between 2.8 rs and 14 rs
    const diskInner = 2.8 * cfg.rs * scale;
    const diskOuter = 14.0 * cfg.rs * scale;
    const diskGrad = radarCtx.createRadialGradient(cx, cy, diskInner, cx, cy, diskOuter);
    diskGrad.addColorStop(0.0, 'rgba(255, 190, 60, 0.40)');
    diskGrad.addColorStop(0.5, 'rgba(255, 90, 10, 0.20)');
    diskGrad.addColorStop(1.0, 'rgba(255, 30, 0, 0.0)');
    radarCtx.fillStyle = diskGrad;
    radarCtx.beginPath();
    radarCtx.arc(cx, cy, diskOuter, 0, Math.PI * 2);
    radarCtx.arc(cx, cy, diskInner, 0, Math.PI * 2, true);
    radarCtx.fill();

    // Photon sphere (1.5 rs)
    radarCtx.strokeStyle = 'rgba(255, 225, 110, 0.75)';
    radarCtx.lineWidth = 1.2;
    radarCtx.beginPath();
    radarCtx.arc(cx, cy, 1.5 * cfg.rs * scale, 0, Math.PI * 2);
    radarCtx.stroke();

    // Black Hole Event Horizon (1.0 rs)
    radarCtx.fillStyle = '#000000';
    radarCtx.beginPath();
    radarCtx.arc(cx, cy, cfg.rs * scale, 0, Math.PI * 2);
    radarCtx.fill();
    radarCtx.strokeStyle = 'rgba(255, 80, 20, 0.85)';
    radarCtx.lineWidth = 1.5;
    radarCtx.stroke();

    // Camera indicator (blue dot)
    if (camera) {
      const camX = cx + camera.position.x * scale;
      const camZ = cy + camera.position.z * scale;
      radarCtx.fillStyle = '#33aaff';
      radarCtx.beginPath();
      radarCtx.arc(camX, camZ, 3, 0, Math.PI * 2);
      radarCtx.fill();
    }

    // Light Source position
    const em = objects.emitter.position;
    const emX = cx + em.x * scale;
    const emZ = cy + em.z * scale;

    // Laser aiming line to black hole center
    // Laser aiming line to black hole center (red dashed line)
    radarCtx.strokeStyle = 'rgba(255, 34, 51, 0.9)';
    radarCtx.lineWidth = 1.5;
    radarCtx.setLineDash([3, 2]);
    radarCtx.beginPath();
    radarCtx.moveTo(emX, emZ);
    radarCtx.lineTo(cx, cy);
    radarCtx.stroke();
    radarCtx.setLineDash([]);

    // Light Source reticle (radiant laser red)
    const emDistRs = em.length() / cfg.rs;
    
    // Outer reticle circle
    radarCtx.strokeStyle = '#ff1122';
    radarCtx.lineWidth = 2;
    radarCtx.beginPath();
    radarCtx.arc(emX, emZ, 5.5, 0, Math.PI * 2);
    radarCtx.stroke();

    // Inner filled core
    radarCtx.fillStyle = '#ff3344';
    radarCtx.beginPath();
    radarCtx.arc(emX, emZ, 2.5, 0, Math.PI * 2);
    radarCtx.fill();

    radarCtx.restore();

    // Update Console Telemetry values
    const telemDist = document.getElementById('telem-dist');
    const telemAngle = document.getElementById('telem-angle');
    const telemElev = document.getElementById('telem-elev');
    const telemCoords = document.getElementById('telem-coords');
    
    if (telemDist) telemDist.textContent = `${emDistRs.toFixed(1)} rs`;
    if (telemAngle) {
      const ang = THREE.MathUtils.radToDeg(Math.atan2(em.x, em.z));
      telemAngle.textContent = `${ang.toFixed(0)}°`;
    }
    if (telemElev) telemElev.textContent = `${em.y.toFixed(1)}`;
    if (telemCoords) telemCoords.textContent = `[${em.x.toFixed(1)}, ${em.y.toFixed(1)}, ${em.z.toFixed(1)}]`;
  }

  // ── Ray lines ────────────────────────────────────────────────────────────
  function getOrCreateRayLine(rayId) {
    if (objects.rayLines[rayId]) return objects.rayLines[rayId];
    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array(MAX_POINTS_PER_RAY * 3);
    const colors    = new Float32Array(MAX_POINTS_PER_RAY * 3);
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
    geom.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      linewidth: cfg.rayThickness,
    });
    const line = new THREE.Line(geom, mat);
    scene.add(line);
    objects.rayLines[rayId]  = line;
    objects.rayColors[rayId] = 'ACTIVE';
    return line;
  }

  function appendRayPositions(rayId, newPositions, status) {
    if (!cfg.showTrails && status !== 'ACTIVE') return;
    const line    = getOrCreateRayLine(rayId);
    const posAttr = line.geometry.attributes.position;
    const colAttr = line.geometry.attributes.color;
    const posArr  = posAttr.array;
    const colArr  = colAttr.array;
    let count     = line.geometry.drawRange.count;

    const finalColor = rayColorForStatus(status);

    for (const [x, y, z] of newPositions) {
      if (count >= MAX_POINTS_PER_RAY) break;
      posArr[count*3]   = x; posArr[count*3+1] = y; posArr[count*3+2] = z;
      // All emitted rays are in laser red shades
      let r, g, b;
      if (status === 'ABSORBED') {
        r = 0.85; g = 0.04; b = 0.02;
      } else if (status === 'ESCAPED') {
        r = 1.0; g = 0.18; b = 0.18;
      } else if (status === 'ORBITING') {
        r = 1.0; g = 0.25; b = 0.15;
      } else {
        // ACTIVE: vibrant glowing red beam
        r = 1.0 * cfg.rayBrightness;
        g = 0.12 * cfg.rayBrightness;
        b = 0.12 * cfg.rayBrightness;
      }
      colArr[count*3] = r; colArr[count*3+1] = g; colArr[count*3+2] = b;
      count++;
    }

    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    line.geometry.setDrawRange(0, count);
    line.material.opacity = 0.88;

    const prevStatus = objects.rayColors[rayId];
    if (status && status !== prevStatus) {
      objects.rayColors[rayId] = status;
      // On final status update repaint all vertices
      const fc = rayColorForStatus(status);
      for (let i = 0; i < count; i++) {
        colArr[i*3] = fc.r * cfg.rayBrightness;
        colArr[i*3+1] = fc.g * cfg.rayBrightness;
        colArr[i*3+2] = fc.b * cfg.rayBrightness;
      }
      colAttr.needsUpdate = true;
      line.material.opacity = status === 'ABSORBED' ? 0.45 : 0.82;
    }
  }

  function clearRays() {
    objects.rayLines.forEach(l => {
      if (l) { scene.remove(l); l.geometry.dispose(); l.material.dispose(); }
    });
    objects.rayLines  = [];
    objects.rayColors = [];
  }

  // ── Initialise scene ─────────────────────────────────────────────────────
  function init() {
    const canvas = document.getElementById('gl-canvas');

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x010103, 1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;

    scene  = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 3000);
    // 82 degrees inclination starting position (r=20, theta=0, phi=1.43)
    camera.position.set(0, 2.78, 19.8);

    const controls = createOrbitControls(camera, canvas);

    // Raymarching background sphere
    const rmGeom = new THREE.SphereGeometry(1200, 32, 32);
    const rmMat  = new THREE.ShaderMaterial({
      uniforms: {
        time:           { value: 0 },
        rs:             { value: cfg.rs },
        diskBrightness: { value: cfg.diskBrightness },
        showPhotonRing: { value: cfg.showPhotonSphere ? 1.0 : 0.0 },
        showTurbulence: { value: cfg.showHotSpots     ? 1.0 : 0.0 },
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main(){
          vec4 wp=modelMatrix*vec4(position,1.0);
          vWorldPosition=wp.xyz;
          gl_Position=projectionMatrix*viewMatrix*wp;
        }
      `,
      fragmentShader: fragmentShaderSource,
      side: THREE.BackSide,
      depthWrite: false, depthTest: false,
    });
    objects.raymarchMesh = new THREE.Mesh(rmGeom, rmMat);
    scene.add(objects.raymarchMesh);

    // Equatorial Grid
    const gridHelper = new THREE.PolarGridHelper(100, 32, 16, 128, 0x00ffff, 0x0088cc);
    gridHelper.position.y = 0;
    gridHelper.material.transparent = true;
    gridHelper.material.opacity = 0.65;
    scene.add(gridHelper);

    // Glowing emitter
    objects.emitter = buildEmitter();
    scene.add(objects.emitter);

    // Floating source label div
    updateSourceLabel();

    // HDR bloom post-processing
    composer = new THREE.EffectComposer(renderer);
    composer.addPass(new THREE.RenderPass(scene, camera));
    const bloom = new THREE.UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.95, 0.45, 0.80
    );
    composer.addPass(bloom);

    // Custom vignette & chromatic aberration cinematic shader pass
    const CinematicShader = {
      uniforms: {
        'tDiffuse': { value: null },
        'chromaticAberration': { value: 0.0018 },
        'vignetteIntensity': { value: 1.15 },
        'vignetteRoundness': { value: 0.85 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float chromaticAberration;
        uniform float vignetteIntensity;
        uniform float vignetteRoundness;
        varying vec2 vUv;
        void main() {
          // Subtle chromatic aberration
          vec2 uvRed = vUv + vec2(chromaticAberration, 0.0);
          vec2 uvBlue = vUv - vec2(chromaticAberration, 0.0);
          float r = texture2D(tDiffuse, uvRed).r;
          float g = texture2D(tDiffuse, vUv).g;
          float b = texture2D(tDiffuse, uvBlue).b;
          vec3 color = vec3(r, g, b);

          // Soft vignette
          vec2 uv = vUv - 0.5;
          float d = length(uv);
          float vign = smoothstep(0.8, 0.4, d * vignetteIntensity);
          color *= mix(1.0, vign, vignetteRoundness);

          gl_FragColor = vec4(color, 1.0);
        }
      `
    };
    const cinematicPass = new THREE.ShaderPass(CinematicShader);
    composer.addPass(cinematicPass);

    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      composer.setSize(window.innerWidth, window.innerHeight);
    });

    initHeatmap();
    initSourceRadar();
    startRenderLoop(controls);
  }

  // ── Source label (floating HUD) ──────────────────────────────────────────
  function updateSourceLabel() {
    let el = document.getElementById('src-label');
    if (!el) {
      el = document.createElement('div');
      el.id = 'src-label';
      el.style.cssText = `
        position:fixed; pointer-events:none; z-index:20;
        font-family:'JetBrains Mono','Fira Code',monospace; font-size:10px;
        color:#ff4455; background:rgba(30,5,10,0.85);
        border:1px solid rgba(255,40,60,0.5); border-radius:6px;
        padding:5px 9px; backdrop-filter:blur(8px);
        text-shadow:0 0 6px #ff2233;
        transition: opacity 0.2s;
      `;
      document.body.appendChild(el);
    }
    return el;
  }

  function positionSourceLabel() {
    const el = document.getElementById('src-label');
    if (!el || !camera || !objects.emitter) return;
    const pos = objects.emitter.position.clone().project(camera);
    const x = (pos.x + 1) / 2 * window.innerWidth;
    const y = (1 - (pos.y + 1) / 2) * window.innerHeight;
    const dist = objects.emitter.position.length() / (2 * cfg.mass);
    const angle = THREE.MathUtils.radToDeg(
      Math.atan2(objects.emitter.position.x, objects.emitter.position.z)
    ).toFixed(1);
    el.style.left = (x + 16) + 'px';
    el.style.top  = (y - 14) + 'px';
    el.innerHTML  = `🔴 Light Source<br>Dist: ${dist.toFixed(1)} r<sub>s</sub><br>Angle: ${angle}°<br>Bound: Facing BH`;
  }

  // ── Render loop ──────────────────────────────────────────────────────────
  function startRenderLoop(controls) {
    let t = 0;
    const targetPos = new THREE.Vector3();

    function animate() {
      animFrame = requestAnimationFrame(animate);
      t += 0.005;

      // Update shader uniforms
      if (objects.raymarchMesh) {
        const u = objects.raymarchMesh.material.uniforms;
        u.time.value = t * 2.2;
      }

      // Animate emitter pulse — always red, never cream/yellow
      if (objects.emitter) {
        const { halo1, halo2, coreMesh, ringMat, boxMat, arrowMat, beamLine } = objects.emitter.userData;

        const pulse = 0.5 + 0.5 * Math.sin(t * 4.5);
        const s = cfg.sourceSize * (1 + 0.12 * pulse);
        objects.emitter.scale.set(s, s, s);

        const redRing = new THREE.Color(0xff2233);
        const redCore = new THREE.Color(0xff1122);

        if (ringMat)  ringMat.color.copy(redRing);
        if (boxMat)   boxMat.color.copy(redRing);
        if (arrowMat) arrowMat.color.copy(redCore);
        if (beamLine) beamLine.material.color.copy(redRing);

        if (halo1) halo1.material.opacity = 0.22 * cfg.sourceGlow * (0.7 + 0.3 * pulse);
        if (halo2) halo2.material.opacity = 0.11 * cfg.sourceGlow * (0.6 + 0.4 * pulse);
        if (coreMesh) {
          const bright = cfg.sourceGlow * (0.85 + 0.15 * pulse);
          coreMesh.material.color.set(0xff1122).multiplyScalar(bright);
        }
      }

      // Camera follow source
      if (cfg.followSource && objects.emitter) {
        targetPos.lerp(objects.emitter.position, 0.03);
        controls.target.lerp(targetPos, 0.06);
        controls.update();
      }

      // Calculate time dilation and redshift at camera position
      if (camera) {
        const camDist = camera.position.length();
        const currentRS = cfg.rs;
        const dilation = 1.0 / Math.sqrt(Math.max(0.001, 1.0 - currentRS / camDist));
        const redshift = dilation - 1.0;

        const redshiftEl = document.getElementById('hud-redshift');
        if (redshiftEl) redshiftEl.textContent = `z= ${redshift.toFixed(2)}`;

        const dilationEl = document.getElementById('hud-dilation');
        if (dilationEl) dilationEl.textContent = `${dilation.toFixed(3)} X`;
      }

      positionSourceLabel();
      updateHeatmap();
      drawSourceRadar();

      composer ? composer.render() : renderer.render(scene, camera);
    }
    animate();
  }

  // ── Public API ───────────────────────────────────────────────────────────
  function updateSceneParams(params) {
    Object.assign(cfg, params);
    if (objects.raymarchMesh) {
      const u = objects.raymarchMesh.material.uniforms;
      if (params.rs !== undefined)             u.rs.value             = params.rs;
      if (params.diskBrightness !== undefined) u.diskBrightness.value = params.diskBrightness;
      if (params.showPhotonSphere !== undefined) u.showPhotonRing.value = params.showPhotonSphere ? 1 : 0;
      if (params.showHotSpots !== undefined)   u.showTurbulence.value = params.showHotSpots ? 1 : 0;
    }
  }

  function updateCameraFrustum(pos, yaw, pitch, fov) {
    if (!objects.emitter) return;
    objects.emitter.visible = true;
    objects.emitter.position.set(...pos);
    objects.emitter.lookAt(0, 0, 0); // always face the black hole
  }

  function setDiskBrightness(v)       { cfg.diskBrightness = v;    updateSceneParams({ diskBrightness: v }); }
  function setPhotonSphereVisible(v)  { updateSceneParams({ showPhotonSphere: v }); }
  function setTrailsVisible(v)        {
    cfg.showTrails = v;
    objects.rayLines.forEach((l, id) => {
      if (l) l.visible = v || objects.rayColors[id] === 'ACTIVE';
    });
  }
  function setHeatmapVisible(v)       {
    heatmapVisible = v;
    if (heatmapCanvas) {
      heatmapCanvas.style.display = v ? 'block' : 'none';
      if (!v && heatmapCtx) heatmapCtx.clearRect(0, 0, heatmapCanvas.width, heatmapCanvas.height);
    }
  }
  function setOnSourceMoved(cb)       { onSourceMovedCallback = cb; }
  function setHotSpotsVisible(v)      { updateSceneParams({ showHotSpots: v }); }
  function setRayBrightness(v)        { cfg.rayBrightness = v; }
  function setRayThickness(v)         {
    cfg.rayThickness = v;
    objects.rayLines.forEach(l => { if (l) l.material.linewidth = v; });
  }
  function setTrailLength(v)          { cfg.trailLength = v; }
  function setSourceSize(v)           { cfg.sourceSize = v; }
  function setSourceGlow(v)           { cfg.sourceGlow = v; }
  function setFollowSource(v)         { cfg.followSource = v; }
  function setContinuousEmit(v)       { cfg.continuousEmit = v; }
  function getRenderer()              { return renderer; }
  function getEmitterPosition()       { return objects.emitter ? objects.emitter.position.clone() : new THREE.Vector3(15, 0, 0); }
  function showPreviewFromEmitter(count, spread) {
    if (!objects.emitter) return;
    const dirs = getFanDirs(objects.emitter.position, count, spread);
    updatePreview(objects.emitter.position, dirs);
  }

  function getBrightnessSample() {
    const t = Date.now() * 0.001;
    return (2.0 + Math.sin(t * 5.6) * 0.45 + Math.sin(t * 12.8) * 0.28 + (Math.random() - 0.5) * 0.12) * cfg.diskBrightness;
  }

  return {
    init,
    clearRays,
    appendRayPositions,
    updateSceneParams,
    updateCameraFrustum,
    setDiskBrightness,
    setPhotonSphereVisible,
    setTrailsVisible,
    setHeatmapVisible,
    setOnSourceMoved,
    setHotSpotsVisible,
    setRayBrightness,
    setRayThickness,
    setTrailLength,
    setSourceSize,
    setSourceGlow,
    setFollowSource,
    setContinuousEmit,
    getRenderer,
    getEmitterPosition,
    setEmitterPosition,
    setEmitterSpherical,
    setEmitterPreset,
    setAutoFaceBH,
    setLockEmitterDrag,
    showPreviewFromEmitter,
    getBrightnessSample,
  };
})();
