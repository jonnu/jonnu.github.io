(function () {
    "use strict";

    var canvas = document.getElementById("starfield");
    if (!canvas || !canvas.getContext) return;

    var ctx = canvas.getContext("2d");
    var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    var CONFIG = {
        density: 1 / 5200, // stars per px²
        maxStars: 450,
        brightShare: 0.04,
        pushRadius: 110,
        pushStrength: 0.05,
        spring: 0.024,
        damping: 0.88,
        textDim: 0.4,
        textFade: 48,
        shootingMin: 60000, // ms
        shootingMax: 300000, // ms
        rotationDegPerSec: 0.12,
        parallaxMin: 0.4,
        parallaxMax: 2.0,
        rotationAxis: [0.2, -1, 0.35],
        halfFovDeg: 40,
        galaxy: {
            x: 0.88, // fraction of viewport
            y: 0.9, // fraction of viewport
            radius: 0.414, // fraction of viewport diagonal
            inclinationDeg: 60,
            tiltDeg: -24,
            spinDegPerSec: 0.4,
            alpha: 0.6,
            textDim: 0.3,
            seed: 20261118
        }
    };

    var TAU = Math.PI * 2;
    var stars = [];
    var width = 0;
    var height = 0;
    var dpr = 1;
    var pointer = { x: -9999, y: -9999, active: false };
    var starRGB = "220, 228, 255";
    var enabled = false;
    var rafId = null;
    var lastTime = 0;
    var textRect = null;
    var shooters = [];
    var nextShootAt = 0;

    var focal = 1;
    var centreX = 0;
    var centreY = 0;
    var skyAngle = 0;
    var AXIS = (function (a) {
        var l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
        return [a[0] / l, a[1] / l, a[2] / l];
    })(CONFIG.rotationAxis);

    function readTheme() {
        enabled = document.body.classList.contains("dark-theme");
        var rgb = getComputedStyle(document.body).getPropertyValue("--star-rgb").trim();
        if (rgb) starRGB = rgb;
    }

    function rand(min, max) { return min + Math.random() * (max - min); }

    function textDimFactor(x, y, rect) {
        if (!rect) return 1;
        var dx = Math.max(rect.left - x, 0, x - rect.right);
        var dy = Math.max(rect.top - y, 0, y - rect.bottom);
        var t = Math.min(Math.sqrt(dx * dx + dy * dy) / CONFIG.textFade, 1);
        return CONFIG.textDim + (1 - CONFIG.textDim) * t;
    }

    function textColumnRect() {
        var main = document.querySelector("main.content");
        if (!main) return null;
        var r = main.getBoundingClientRect();
        var style = getComputedStyle(main);
        return {
            left: r.left + parseFloat(style.paddingLeft),
            right: r.right - parseFloat(style.paddingRight),
            top: 0,
            bottom: height
        };
    }

    function makeStar() {
        var bright = Math.random() < CONFIG.brightShare;
        var depth = bright ? rand(0.75, 1) : Math.pow(Math.random(), 2.2);
        var r = bright ? rand(0.85, 1.25) : 0.25 + depth * 0.6 + rand(-0.05, 0.1);

        var uz = rand(-1, 1);
        var t = Math.random() * TAU;
        var ring = Math.sqrt(1 - uz * uz);
        var ux = ring * Math.cos(t);
        var uy = ring * Math.sin(t);

        return onSky({
            x: 0, y: 0, vis: false,
            offX: 0, offY: 0, vx: 0, vy: 0,
            r: Math.max(0.2, r),
            a: bright ? rand(0.55, 0.75) : 0.16 + depth * 0.5,
            give: 0.35 + depth * 0.65,
            spd: CONFIG.parallaxMin + (CONFIG.parallaxMax - CONFIG.parallaxMin) * depth,
            bright: bright,
            twPhase1: Math.random() * TAU,
            twPhase2: Math.random() * TAU,
            twSpeed1: TAU / rand(2500, 9000),
            twSpeed2: TAU / rand(1100, 3200),
            twDepth: rand(0.2, 0.55)
        }, ux, uy, uz);
    }

    // Precomputes axis × u and axis · u for Rodrigues' rotation.
    function onSky(o, ux, uy, uz) {
        var kx = AXIS[0], ky = AXIS[1], kz = AXIS[2];
        o.ux = ux; o.uy = uy; o.uz = uz;
        o.wx = ky * uz - kz * uy;
        o.wy = kz * ux - kx * uz;
        o.wz = kx * uy - ky * ux;
        o.kd = kx * ux + ky * uy + kz * uz;
        return o;
    }


    var galaxy = null;

    function seeded(seed) {
        return function () { // mulberry32
            seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
            var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function paintGalaxy(R) {
        var G = CONFIG.galaxy;
        var rnd = seeded(G.seed);
        function gauss() { return Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(TAU * rnd()); }

        var big = Math.max(1, R / 120);
        var dotK = Math.min(2, Math.sqrt(big));
        // Capped at 2048px: a full-DPR sprite on a large display costs 50MB+.
        var px = Math.min(dpr, 2048 / (2 * R));
        var size = Math.ceil(2 * R * px);
        var off = document.createElement("canvas");
        off.width = off.height = size;
        var g = off.getContext("2d");
        g.translate(size / 2, size / 2);
        g.scale(px, px);

        var haze = g.createRadialGradient(0, 0, 0, 0, 0, R);
        haze.addColorStop(0, "rgba(215, 220, 255, 0.10)");
        haze.addColorStop(0.35, "rgba(190, 200, 255, 0.035)");
        haze.addColorStop(1, "rgba(190, 200, 255, 0)");
        g.fillStyle = haze;
        g.fillRect(-R, -R, 2 * R, 2 * R);

        g.globalCompositeOperation = "lighter";
        function dot(x, y, r, rgb, a) {
            g.fillStyle = "rgba(" + rgb + "," + a.toFixed(3) + ")";
            g.beginPath();
            g.arc(x, y, r * dotK, 0, TAU);
            g.fill();
        }

        // Glow is drawn on a low-res layer at a higher alpha and blended in once:
        // stacking thousands of very faint dots in an 8-bit canvas shifts the hue.
        var GLOW_SCALE = 0.25;
        var gs = Math.ceil(2 * R * GLOW_SCALE);
        var glowCanvas = document.createElement("canvas");
        glowCanvas.width = glowCanvas.height = gs;
        var gl = glowCanvas.getContext("2d");
        gl.translate(gs / 2, gs / 2);
        gl.scale(GLOW_SCALE, GLOW_SCALE);
        gl.globalCompositeOperation = "lighter";
        gl.fillStyle = "rgba(180, 198, 255, 0.03)";

        var ARMS = 2, K = 3.2;
        var armCount = Math.min(14000, Math.round(5000 * big));
        for (var i = 0; i < armCount; i++) {
            var rr = 0.08 + 0.9 * Math.pow(rnd(), 0.9);
            var theta = (i % ARMS) * (TAU / ARMS) + K * Math.log(rr) + gauss() * (0.2 + 0.3 * rr);
            var rad = (rr + gauss() * (0.02 + 0.05 * rr)) * R;
            var fade = 1 - smoothstep(0.3, 0.85, rad / R);
            var x = Math.cos(theta) * rad, y = Math.sin(theta) * rad;
            var knot = rnd() < 0.025;
            if (i < 5000 && rnd() < fade) {
                gl.beginPath();
                gl.arc(x, y, (4 + rnd() * 4) * big, 0, TAU);
                gl.fill();
            }
            dot(x, y, knot ? 0.6 + rnd() * 0.4 : 0.25 + rnd() * 0.35,
                knot ? "255, 190, 210" : "200, 214, 255",
                (knot ? 0.3 : 0.04 + rnd() * 0.08) * fade);
        }

        g.save();
        g.globalAlpha = 0.16;
        g.drawImage(glowCanvas, -R, -R, 2 * R, 2 * R);
        g.restore();

        for (var j = 0; j < 900 * big; j++) {
            var dr = Math.min(-Math.log(rnd() + 1e-9) * 0.28, 1) * R;
            var da = rnd() * TAU;
            dot(Math.cos(da) * dr, Math.sin(da) * dr, 0.25 + rnd() * 0.3,
                "215, 220, 240", (0.03 + rnd() * 0.07) * (1 - dr / R));
        }

        for (var b = 0; b < 600 * big; b++) {
            var br = Math.abs(gauss()) * 0.09 * R;
            var ba = rnd() * TAU;
            dot(Math.cos(ba) * br, Math.sin(ba) * br, 0.25 + rnd() * 0.4,
                "255, 228, 195", 0.04 + rnd() * 0.09);
        }
        var core = g.createRadialGradient(0, 0, 0, 0, 0, 0.16 * R);
        core.addColorStop(0, "rgba(255, 236, 210, 0.55)");
        core.addColorStop(0.4, "rgba(255, 226, 195, 0.18)");
        core.addColorStop(1, "rgba(255, 226, 195, 0)");
        g.fillStyle = core;
        g.beginPath();
        g.arc(0, 0, 0.16 * R, 0, TAU);
        g.fill();

        g.globalCompositeOperation = "destination-in";
        var mask = g.createRadialGradient(0, 0, 0, 0, 0, R);
        mask.addColorStop(0, "rgba(0,0,0,1)");
        mask.addColorStop(0.4, "rgba(0,0,0,1)");
        mask.addColorStop(0.62, "rgba(0,0,0,0.6)");
        mask.addColorStop(0.8, "rgba(0,0,0,0.18)");
        mask.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = mask;
        g.fillRect(-R, -R, 2 * R, 2 * R);

        return off;
    }

    function smoothstep(a, b, x) {
        var t = Math.min(1, Math.max(0, (x - a) / (b - a)));
        return t * t * (3 - 2 * t);
    }

    function buildGalaxy() {
        var R = CONFIG.galaxy.radius * Math.sqrt(width * width + height * height);
        galaxy = { R: R, spin: galaxy ? galaxy.spin : 0, sprite: paintGalaxy(R) };
    }

    function drawGalaxy() {
        if (!galaxy) return;
        var G = CONFIG.galaxy;
        var R = galaxy.R;

        ctx.save();
        ctx.globalAlpha = G.alpha;
        ctx.translate(G.x * width, G.y * height);
        ctx.rotate(G.tiltDeg * Math.PI / 180);
        ctx.scale(1, Math.cos(G.inclinationDeg * Math.PI / 180));
        ctx.rotate(-galaxy.spin); // negative so the arms trail the rotation
        ctx.drawImage(galaxy.sprite, -R, -R, 2 * R, 2 * R);
        ctx.restore();

        // Dims only the galaxy behind the text: stars are drawn after this.
        var rect = textRect;
        if (!rect) return;
        var f = CONFIG.textFade;
        var x0 = rect.left - f, x1 = rect.right + f;
        if (x1 <= 0 || x0 >= width) return;
        var cut = 1 - G.textDim;
        var grad = ctx.createLinearGradient(x0, 0, x1, 0);
        var e = f / (x1 - x0);
        grad.addColorStop(0, "rgba(0,0,0,0)");
        grad.addColorStop(e, "rgba(0,0,0," + cut + ")");
        grad.addColorStop(1 - e, "rgba(0,0,0," + cut + ")");
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        ctx.fillStyle = grad;
        ctx.fillRect(x0, 0, x1 - x0, height);
        ctx.restore();
    }

    function build() {
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        var box = canvas.getBoundingClientRect();
        width = box.width || window.innerWidth;
        height = box.height || window.innerHeight;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        textRect = textColumnRect();

        // Stereographic projection: r = 2·f·tan(θ/2).
        var halfDiag = Math.sqrt(width * width + height * height) / 2;
        focal = halfDiag / (2 * Math.tan((CONFIG.halfFovDeg * Math.PI / 180) / 2));
        centreX = width / 2;
        centreY = height / 2;

        var target = Math.min(CONFIG.maxStars, Math.round(width * height * CONFIG.density));
        var onScreen = 0;
        stars = [];
        for (var guard = 0; onScreen < target && guard < 40000; guard++) {
            var s = makeStar();
            stars.push(s);
            project(s, Math.cos(skyAngle * s.spd), Math.sin(skyAngle * s.spd));
            if (s.vis) onScreen++;
        }

        buildGalaxy();
    }

    var MARGIN = 24;
    function project(s, c, sn, margin) {
        var m = margin === undefined ? MARGIN : margin;
        var omc = (1 - c) * s.kd;
        var rx = s.ux * c + s.wx * sn + AXIS[0] * omc;
        var ry = s.uy * c + s.wy * sn + AXIS[1] * omc;
        var rz = s.uz * c + s.wz * sn + AXIS[2] * omc;
        var den = 1 + rz;
        if (den < 0.05) { s.vis = false; return; }
        var bx = centreX + 2 * focal * rx / den;
        var by = centreY + 2 * focal * ry / den;
        s.vis = bx > -m && bx < width + m && by > -m && by < height + m;
        s.bx = bx;
        s.by = by;
    }

    function step(dt, physics) {
        var R = CONFIG.pushRadius;
        var R2 = R * R;
        var k = CONFIG.spring;
        var damp = Math.pow(CONFIG.damping, dt);
        var px = pointer.x;
        var py = pointer.y;
        var on = pointer.active;

        for (var i = 0; i < stars.length; i++) {
            var s = stars[i];
            var ang = skyAngle * s.spd;
            project(s, Math.cos(ang), Math.sin(ang));
            if (!s.vis) {
                s.offX = s.offY = s.vx = s.vy = 0;
                continue;
            }
            if (!physics) {
                s.x = s.bx;
                s.y = s.by;
                continue;
            }

            var ax = -s.offX * k;
            var ay = -s.offY * k;

            if (on) {
                var dx = s.bx + s.offX - px;
                var dy = s.by + s.offY - py;
                var d2 = dx * dx + dy * dy;
                if (d2 < R2 && d2 > 0.01) {
                    var d = Math.sqrt(d2);
                    var f = 1 - d / R;
                    f = f * f * CONFIG.pushStrength * s.give;
                    ax += (dx / d) * f;
                    ay += (dy / d) * f;
                }
            }

            s.vx = (s.vx + ax * dt) * damp;
            s.vy = (s.vy + ay * dt) * damp;
            s.offX += s.vx * dt;
            s.offY += s.vy * dt;
            s.x = s.bx + s.offX;
            s.y = s.by + s.offY;
        }
    }

    function twinkle(s, time) {
        var w = 0.65 * Math.sin(s.twPhase1 + time * s.twSpeed1) +
                0.35 * Math.sin(s.twPhase2 + time * s.twSpeed2);
        return 1 - s.twDepth * (0.5 + 0.5 * w);
    }

    function draw(time) {
        ctx.clearRect(0, 0, width, height);
        drawGalaxy();
        var animate = !reducedMotion.matches;

        for (var i = 0; i < stars.length; i++) {
            var s = stars[i];
            if (!s.vis) continue;
            var a = (animate ? s.a * twinkle(s, time) : s.a) * textDimFactor(s.x, s.y, textRect);

            if (s.bright) {
                var halo = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 3.5);
                halo.addColorStop(0, "rgba(" + starRGB + "," + (a * 0.35).toFixed(3) + ")");
                halo.addColorStop(1, "rgba(" + starRGB + ",0)");
                ctx.fillStyle = halo;
                ctx.beginPath();
                ctx.arc(s.x, s.y, s.r * 3.5, 0, TAU);
                ctx.fill();
            }

            ctx.fillStyle = "rgba(" + starRGB + "," + a.toFixed(3) + ")";
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.r, 0, TAU);
            ctx.fill();
        }
    }


    function bezier(p0, c, p1, t) {
        var u = 1 - t;
        return u * u * p0 + 2 * u * t * c + t * t * p1;
    }

    function spawnShooter(time) {
        var dir = Math.random() < 0.5 ? 1 : -1;
        var sx = dir > 0 ? rand(-0.05, 0.45) * width : rand(0.55, 1.05) * width;
        var sy = rand(-0.05, 0.3) * height;
        var angle = rand(0.2, 0.6);
        var len = rand(0.7, 1.0) * Math.max(width, height);
        var ex = sx + dir * Math.cos(angle) * len;
        var ey = sy + Math.sin(angle) * len;

        var nx = -(ey - sy) / len;
        var ny = (ex - sx) / len;
        if (ny > 0) { nx = -nx; ny = -ny; }
        var bend = rand(0.06, 0.12) * len;

        shooters.push({
            x0: sx, y0: sy, x1: ex, y1: ey,
            cx: (sx + ex) / 2 + nx * bend,
            cy: (sy + ey) / 2 + ny * bend,
            born: time,
            duration: rand(900, 1300),
            trail: rand(0.25, 0.35),
            peak: rand(0.75, 0.9)
        });
    }

    function shooterDim(x, y) {
        return 0.6 + 0.4 * textDimFactor(x, y, textRect);
    }

    function drawShooter(m, time) {
        var u = (time - m.born) / m.duration;
        if (u >= 1) return false;

        var head = 0.6 * u + 0.4 * u * u;
        var life = Math.min(u / 0.12, 1) * Math.min((1 - u) / 0.4, 1);
        var tail = Math.max(0, head - m.trail);
        var SEGMENTS = 28;

        ctx.lineCap = "round";
        var px = bezier(m.x0, m.cx, m.x1, tail);
        var py = bezier(m.y0, m.cy, m.y1, tail);
        for (var i = 1; i <= SEGMENTS; i++) {
            var k = i / SEGMENTS;
            var t = tail + (head - tail) * k;
            var x = bezier(m.x0, m.cx, m.x1, t);
            var y = bezier(m.y0, m.cy, m.y1, t);
            var a = m.peak * life * Math.pow(k, 1.6) * shooterDim(x, y);
            ctx.strokeStyle = "rgba(" + starRGB + "," + a.toFixed(3) + ")";
            ctx.lineWidth = 0.3 + 1.8 * k;
            ctx.beginPath();
            ctx.moveTo(px, py);
            ctx.lineTo(x, y);
            ctx.stroke();
            px = x;
            py = y;
        }

        var ha = m.peak * life * shooterDim(px, py);
        var glow = ctx.createRadialGradient(px, py, 0, px, py, 6);
        glow.addColorStop(0, "rgba(" + starRGB + "," + ha.toFixed(3) + ")");
        glow.addColorStop(1, "rgba(" + starRGB + ",0)");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(px, py, 6, 0, TAU);
        ctx.fill();
        return true;
    }

    function updateShooters(time) {
        if (time >= nextShootAt) {
            spawnShooter(time);
            nextShootAt = time + rand(CONFIG.shootingMin, CONFIG.shootingMax);
        }
        shooters = shooters.filter(function (m) { return drawShooter(m, time); });
    }

    function frame(time) {
        if (!nextShootAt) nextShootAt = time + rand(CONFIG.shootingMin, CONFIG.shootingMax);
        var dt = lastTime ? Math.min((time - lastTime) / 16.667, 3) : 1;
        lastTime = time;
        // Not wrapped to 2π: per-star speed multipliers would turn a wrap into a jump.
        skyAngle += CONFIG.rotationDegPerSec * (Math.PI / 180) * dt * 0.016667;
        if (galaxy) galaxy.spin = (galaxy.spin + CONFIG.galaxy.spinDegPerSec * (Math.PI / 180) * dt * 0.016667) % TAU;
        step(dt, true);
        draw(time);
        updateShooters(time);
        rafId = requestAnimationFrame(frame);
    }

    function stop() {
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId = null;
    }

    function start() {
        stop();
        if (!enabled || document.hidden) {
            ctx.clearRect(0, 0, width, height);
            return;
        }
        if (reducedMotion.matches) {
            step(0, false);
            draw(0);
            return;
        }
        lastTime = 0;
        shooters = [];
        rafId = requestAnimationFrame(frame);
    }


    window.addEventListener("pointermove", function (e) {
        pointer.x = e.clientX;
        pointer.y = e.clientY;
        pointer.active = true;
    }, { passive: true });

    function releasePointer() { pointer.active = false; }
    window.addEventListener("blur", releasePointer);
    window.addEventListener("pointercancel", releasePointer);
    window.addEventListener("pointerup", function (e) {
        if (e.pointerType !== "mouse") releasePointer();
    });
    document.documentElement.addEventListener("mouseleave", releasePointer);

    var resizeTimer = null;
    window.addEventListener("resize", function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () { build(); start(); }, 150);
    });

    document.addEventListener("visibilitychange", start);

    if (reducedMotion.addEventListener) {
        reducedMotion.addEventListener("change", start);
    }

    new MutationObserver(function () {
        readTheme();
        start();
    }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

    readTheme();
    build();
    start();
})();
