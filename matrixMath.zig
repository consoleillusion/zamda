// vec3 math + mat4 transforms, ported from the JS reference.
// Convention: vec3 = 3 contiguous f64s, mat4 = 16 f64s ROW-MAJOR
// (out[r*4 + c]), matching the JS source. All pointers are offsets
// into WASM linear memory; caller lays out inputs/outputs and passes
// pointers. Freestanding target: no libc, math via std + builtins.

const std = @import("std");
const math = std.math;

// ---------- small internal helpers (by-value, not exported) ----------

const Vec3 = [3]f64;

inline fn ld3(p: [*]const f64) Vec3 {
    return .{ p[0], p[1], p[2] };
}
inline fn st3(p: [*]f64, v: Vec3) void {
    p[0] = v[0];
    p[1] = v[1];
    p[2] = v[2];
}

inline fn vsub(a: Vec3, b: Vec3) Vec3 {
    return .{ a[0] - b[0], a[1] - b[1], a[2] - b[2] };
}
inline fn vdot(a: Vec3, b: Vec3) f64 {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
inline fn vcross(a: Vec3, b: Vec3) Vec3 {
    return .{
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    };
}
inline fn vlen(v: Vec3) f64 {
    // hypot-style: avoids overflow vs naive sqrt(x*x+y*y+z*z) for huge inputs.
    return @sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}
inline fn vnorm(v: Vec3) Vec3 {
    const len = vlen(v);
    if (len == 0) return .{ 0, 0, 0 };
    return .{ v[0] / len, v[1] / len, v[2] / len };
}

// ---------- vec3 ops ----------

export fn vec3(out: [*]f64, x: f64, y: f64, z: f64) void {
    out[0] = x;
    out[1] = y;
    out[2] = z;
}

export fn add(out: [*]f64, a: [*]const f64, b: [*]const f64) void {
    st3(out, .{ a[0] + b[0], a[1] + b[1], a[2] + b[2] });
}

export fn sub(out: [*]f64, a: [*]const f64, b: [*]const f64) void {
    st3(out, vsub(ld3(a), ld3(b)));
}

export fn scale(out: [*]f64, v: [*]const f64, s: f64) void {
    st3(out, .{ v[0] * s, v[1] * s, v[2] * s });
}

export fn dot(a: [*]const f64, b: [*]const f64) f64 {
    return vdot(ld3(a), ld3(b));
}

export fn cross(out: [*]f64, a: [*]const f64, b: [*]const f64) void {
    st3(out, vcross(ld3(a), ld3(b)));
}

export fn length(v: [*]const f64) f64 {
    return vlen(ld3(v));
}

export fn normalize(out: [*]f64, v: [*]const f64) void {
    st3(out, vnorm(ld3(v)));
}

export fn distance(a: [*]const f64, b: [*]const f64) f64 {
    return vlen(vsub(ld3(a), ld3(b)));
}

export fn lerp(out: [*]f64, a: [*]const f64, b: [*]const f64, t: f64) void {
    st3(out, .{
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    });
}

// ---------- mat4 ops (row-major, 16 f64s) ----------

export fn identity(out: [*]f64) void {
    const m = [16]f64{
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
    };
    out[0..16].* = m;
}

export fn multiplyMat4(out: [*]f64, a: [*]const f64, b: [*]const f64) void {
    // Matches the JS indexing exactly: out[r*4+c] = sum_k a[r*4+k]*b[c+4*k].
    var r: usize = 0;
    while (r < 4) : (r += 1) {
        var c: usize = 0;
        while (c < 4) : (c += 1) {
            out[r * 4 + c] =
                a[r * 4 + 0] * b[c + 0] +
                a[r * 4 + 1] * b[c + 4] +
                a[r * 4 + 2] * b[c + 8] +
                a[r * 4 + 3] * b[c + 12];
        }
    }
}

export fn transformPoint(out: [*]f64, m: [*]const f64, v: [*]const f64) void {
    const x = v[0];
    const y = v[1];
    const z = v[2];
    const w = m[12] * x + m[13] * y + m[14] * z + m[15];
    st3(out, .{
        (m[0] * x + m[1] * y + m[2] * z + m[3]) / w,
        (m[4] * x + m[5] * y + m[6] * z + m[7]) / w,
        (m[8] * x + m[9] * y + m[10] * z + m[11]) / w,
    });
}

export fn translation(out: [*]f64, tx: f64, ty: f64, tz: f64) void {
    const m = [16]f64{
        1, 0, 0, tx,
        0, 1, 0, ty,
        0, 0, 1, tz,
        0, 0, 0, 1,
    };
    out[0..16].* = m;
}

export fn scaling(out: [*]f64, sx: f64, sy: f64, sz: f64) void {
    const m = [16]f64{
        sx, 0,  0,  0,
        0,  sy, 0,  0,
        0,  0,  sz, 0,
        0,  0,  0,  1,
    };
    out[0..16].* = m;
}

export fn rotate(out: [*]f64, axis: [*]const f64, angle: f64) void {
    const a = vnorm(ld3(axis));
    const x = a[0];
    const y = a[1];
    const z = a[2];
    const c = @cos(angle);
    const s = @sin(angle);
    const t = 1 - c;
    const m = [16]f64{
        t * x * x + c,     t * x * y - s * z, t * x * z + s * y, 0,
        t * x * y + s * z, t * y * y + c,     t * y * z - s * x, 0,
        t * x * z - s * y, t * y * z + s * x, t * z * z + c,     0,
        0,                 0,                 0,                 1,
    };
    out[0..16].* = m;
}

export fn lookAt(out: [*]f64, eye: [*]const f64, target: [*]const f64, up: [*]const f64) void {
    const e = ld3(eye);
    const z = vnorm(vsub(e, ld3(target)));
    const x = vnorm(vcross(ld3(up), z));
    const y = vcross(z, x);
    const m = [16]f64{
        x[0], x[1], x[2], -vdot(x, e),
        y[0], y[1], y[2], -vdot(y, e),
        z[0], z[1], z[2], -vdot(z, e),
        0,    0,    0,    1,
    };
    out[0..16].* = m;
}

export fn perspective(out: [*]f64, fov: f64, aspect: f64, near: f64, far: f64) void {
    const f = 1 / @tan(fov / 2);
    const m = [16]f64{
        f / aspect, 0, 0,                            0,
        0,          f, 0,                            0,
        0,          0, (far + near) / (near - far),  (2 * far * near) / (near - far),
        0,          0, -1,                           0,
    };
    out[0..16].* = m;
}
extern const __heap_base: u8;
export fn heapBase() usize {
    return @intFromPtr(&__heap_base);
}
