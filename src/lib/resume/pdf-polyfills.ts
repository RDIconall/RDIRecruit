/**
 * pdf-parse v2 loads `pdfjs-dist/legacy`, which has a module-level
 * `const SCALE_MATRIX = new DOMMatrix()` and only polyfills `DOMMatrix` from the
 * optional `@napi-rs/canvas` package via a runtime `createRequire`. On Vercel
 * that package isn't traced into the serverless bundle (the dynamic require is
 * invisible to @vercel/nft), so `DOMMatrix` is undefined and the module throws
 * `ReferenceError: DOMMatrix is not defined` at load — silently killing every
 * PDF résumé ingest. Locally it "works" only because `@napi-rs/canvas` happens
 * to resolve. Polyfilling `globalThis.DOMMatrix` from our own bundled code,
 * before pdf-parse is imported, removes the dependency on canvas entirely.
 *
 * We only need a correct 2D affine matrix: pdfjs uses `DOMMatrix` for transforms
 * (a–f, scaleSelf/translateSelf/multiplySelf). Text extraction never invokes the
 * canvas rendering paths, so the matrix mainly needs to exist and be constructable;
 * the operations are implemented correctly regardless for safety.
 */
class DOMMatrixPolyfill {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;
  readonly is2D = true;

  constructor(init?: number[] | Float32Array | Float64Array | string) {
    if (init == null) return;
    if (typeof init === "string") {
      const match = init.match(/matrix\(([^)]+)\)/);
      if (match) {
        const parts = match[1]!.split(",").map((n) => Number(n.trim()));
        if (parts.length === 6 && parts.every((n) => Number.isFinite(n))) {
          [this.a, this.b, this.c, this.d, this.e, this.f] = parts as [
            number, number, number, number, number, number,
          ];
        }
      }
      return;
    }
    const arr = Array.from(init);
    if (arr.length === 6) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = arr as [
        number, number, number, number, number, number,
      ];
    } else if (arr.length === 16) {
      this.a = arr[0]!;
      this.b = arr[1]!;
      this.c = arr[4]!;
      this.d = arr[5]!;
      this.e = arr[12]!;
      this.f = arr[13]!;
    }
  }

  get m11() { return this.a; }
  get m12() { return this.b; }
  get m21() { return this.c; }
  get m22() { return this.d; }
  get m41() { return this.e; }
  get m42() { return this.f; }
  get isIdentity() {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
  }

  multiplySelf(o: DOMMatrixPolyfill): this {
    const a = this.a * o.a + this.c * o.b;
    const b = this.b * o.a + this.d * o.b;
    const c = this.a * o.c + this.c * o.d;
    const d = this.b * o.c + this.d * o.d;
    const e = this.a * o.e + this.c * o.f + this.e;
    const f = this.b * o.e + this.d * o.f + this.f;
    this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f;
    return this;
  }

  multiply(o: DOMMatrixPolyfill): DOMMatrixPolyfill {
    return this.clone().multiplySelf(o);
  }

  translateSelf(tx = 0, ty = 0): this {
    this.e = this.a * tx + this.c * ty + this.e;
    this.f = this.b * tx + this.d * ty + this.f;
    return this;
  }

  translate(tx = 0, ty = 0): DOMMatrixPolyfill {
    return this.clone().translateSelf(tx, ty);
  }

  scaleSelf(sx = 1, sy = sx): this {
    this.a *= sx;
    this.b *= sx;
    this.c *= sy;
    this.d *= sy;
    return this;
  }

  scale(sx = 1, sy = sx): DOMMatrixPolyfill {
    return this.clone().scaleSelf(sx, sy);
  }

  invertSelf(): this {
    const det = this.a * this.d - this.b * this.c;
    if (!det) {
      this.a = this.b = this.c = this.d = this.e = this.f = NaN;
      return this;
    }
    const { a, b, c, d, e, f } = this;
    this.a = d / det;
    this.b = -b / det;
    this.c = -c / det;
    this.d = a / det;
    this.e = (c * f - d * e) / det;
    this.f = (b * e - a * f) / det;
    return this;
  }

  inverse(): DOMMatrixPolyfill {
    return this.clone().invertSelf();
  }

  clone(): DOMMatrixPolyfill {
    return new DOMMatrixPolyfill([this.a, this.b, this.c, this.d, this.e, this.f]);
  }

  toString(): string {
    return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f})`;
  }
}

/**
 * Install a `DOMMatrix` global if the runtime lacks one. Must be called before
 * `pdf-parse` (and thus pdfjs) is imported. Idempotent and side-effect free when
 * a native `DOMMatrix` already exists (e.g. browsers or when `@napi-rs/canvas`
 * resolved first).
 */
export function ensurePdfPolyfills(): void {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.DOMMatrix === "undefined") {
    g.DOMMatrix = DOMMatrixPolyfill;
  }
}
