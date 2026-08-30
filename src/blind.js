/**
 * Molibra - blind-signature credentials, phase 1: the cryptography.
 *
 * ## What this is for
 *
 * Today an expression is signed by the address that makes it, so the chain
 * records *who* alongside *when* and *where* - and that public, permanent link
 * between a person and a political participation is the thing doc 28 § 8.7
 * says must not exist. Hiding it in the explorer fixes nothing, because every
 * node serves the raw transaction.
 *
 * The fix is to stop putting it there. A person proves to the **publisher**
 * that they may speak in a voting place, and receives a **credential the
 * publisher cannot recognise afterwards**. They then express from an address
 * that has no relationship to their identity, presenting the credential. The
 * chain verifies the credential is genuine and refuses a second use of it.
 *
 *   - **Unlinkable**: the publisher signs a *blinded* message and never sees
 *     the credential that results. Given a credential on the chain, it cannot
 *     tell which of its signing sessions produced it.
 *   - **Unique**: the credential's serial is revealed when it is spent, so a
 *     second expression with the same credential is refused by consensus.
 *
 * ## What it does NOT give, stated before anyone assumes it
 *
 * **This is not coercion resistance.** The person still holds the credential
 * and can prove they used it. Coercion resistance requires them to be UNABLE
 * to prove even when they want to, and that needs re-voting or a mixnet
 * (WHITEPAPER § 8.1). This buys **unlinkability**, which is a different and
 * lesser property, and it should be called by its own name.
 *
 * The publisher also still learns **that** an account asked for a credential
 * for a given voting place - just not which expression became theirs. That is
 * the standard trade in blind-signature voting and it is worth stating plainly
 * rather than glossing.
 *
 * ## Why per-voting-place keys
 *
 * The publisher must be able to refuse a second credential to the same person
 * for the same voting place - otherwise one person takes ten credentials and
 * speaks ten times, unlinkably, which is worse than what we have now. But the
 * publisher cannot see which voting place a *blinded* message is for.
 *
 * So the voting place is carried by the **key**, not by the message: each
 * voting place has its own RSA key pair. A credential for one place is
 * mathematically useless in another, and the quota is enforceable because the
 * publisher chooses which key to sign with. (The textbook alternative is a
 * partially-blind signature, where the signer contributes a visible field.
 * Separate keys achieve the same end with primitives that are easier to get
 * right, which matters for code that has to be reviewed.)
 *
 * ## Implementation note, and a caveat that is not decoration
 *
 * The **private** operation is done by `node:crypto` with `RSA_NO_PADDING`,
 * never by hand: `privateEncrypt` on a raw block is exactly m^d mod n. Only
 * the **public** operations - blinding, unblinding, verification - are BigInt
 * arithmetic here, because the browser needs them and they involve no secret.
 *
 * ⚠ RSA-FDH blind signatures are a well-studied construction, but this is a
 * fresh implementation of them and it has not been reviewed by anybody. It
 * must not carry a real electorate until it has been. The tests in
 * `test/blind.mjs` check correctness, forgery, cross-place reuse and the
 * unlinkability property itself; they do not substitute for review.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync,
         privateEncrypt, randomBytes, constants } from 'node:crypto';

export const MODULUS_BITS = 2048;

/* --------------------------------------------------------------- helpers */

const bytesToBig = (bytes) => {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
};

const bigToBytes = (value, length) => {
  const out = new Uint8Array(length);
  let n = BigInt(value);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  if (n !== 0n) throw new Error('value does not fit in the requested length');
  return out;
};

/** Modular exponentiation, square-and-multiply. Public exponents only. */
export function modPow(base, exponent, modulus) {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

/** Modular inverse by the extended Euclidean algorithm. Throws when none. */
export function modInverse(a, m) {
  let [old_r, r] = [((a % m) + m) % m, m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  if (old_r !== 1n) throw new Error('no modular inverse: value shares a factor with the modulus');
  return ((old_s % m) + m) % m;
}

/* ------------------------------------------------------------------ keys */

/**
 * A credential key for ONE voting place. Generated fresh: deriving it from a
 * master key would make every place's key recoverable from one compromise,
 * and the whole point of the separation is that places do not share fate.
 */
export function generateCredentialKey() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: MODULUS_BITS,
    publicExponent: 65537,
  });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

/** The public parameters a client (or a validator) needs: modulus and exponent. */
export function publicParams(publicKeyPem) {
  const jwk = createPublicKey(publicKeyPem).export({ format: 'jwk' });
  const n = bytesToBig(Buffer.from(jwk.n, 'base64url'));
  const e = bytesToBig(Buffer.from(jwk.e, 'base64url'));
  return { n, e, bytes: Buffer.from(jwk.n, 'base64url').length };
}

/* ------------------------------------------------------- full-domain hash */

/**
 * Hash a message to an integer mod n, MGF1-style: SHA-256 over the message
 * with a counter, expanded past the modulus size and then reduced.
 *
 * The expansion runs 8 bytes LONGER than the modulus before reduction, so the
 * bias introduced by reducing is below 2^-64 rather than the very visible bias
 * of hashing to exactly the modulus width. A short hash placed in a long field
 * would be worse still: RSA signatures over a low-entropy message space are
 * forgeable by construction, which is why full-domain hashing exists.
 */
export function fullDomainHash(message, { n, bytes }) {
  const wanted = bytes + 8;
  const chunks = [];
  const data = Buffer.isBuffer(message) ? message : Buffer.from(message);
  for (let counter = 0; chunks.length * 32 < wanted; counter++) {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter);
    chunks.push(createHash('sha256').update(Buffer.concat([Buffer.from('molibra/fdh/v1'), c, data])).digest());
  }
  const wide = bytesToBig(Buffer.concat(chunks).subarray(0, wanted));
  const m = wide % n;
  // 0 has no useful signature and 1 signs to itself; neither can arise from a
  // hash in practice, but a credential scheme should not depend on "in
  // practice" for a check this cheap.
  return m < 2n ? 2n : m;
}

/* -------------------------------------------------------- the three steps */

/**
 * Step 1, in the client: blind a credential serial so the publisher signs
 * something it cannot read.
 */
export function blind(serial, params) {
  const { n, e, bytes } = params;
  const m = fullDomainHash(serial, params);
  for (;;) {
    const r = bytesToBig(randomBytes(bytes)) % n;
    if (r < 2n) continue;
    let rInv;
    try { rInv = modInverse(r, n); } catch { continue; } // shares a factor: vanishingly rare
    return {
      blinded: (m * modPow(r, e, n)) % n,
      unblinder: rInv,
    };
  }
}

/**
 * Step 2, in the publisher: sign the blinded value.
 *
 * The private exponentiation is done by node:crypto, not by BigInt code here.
 * `RSA_NO_PADDING` on a full-width block is exactly m^d mod n, and using the
 * platform for it keeps the secret out of arithmetic nobody has reviewed.
 */
export function signBlinded(blinded, privateKeyPem, params) {
  const key = createPrivateKey(privateKeyPem);
  const block = Buffer.from(bigToBytes(blinded, params.bytes));
  const signed = privateEncrypt({ key, padding: constants.RSA_NO_PADDING }, block);
  return bytesToBig(signed);
}

/** Step 3, in the client: remove the blinding, leaving a genuine signature. */
export function unblind(blindSignature, unblinder, { n }) {
  return (blindSignature * unblinder) % n;
}

/**
 * What a validator runs. No secret involved, so it is plain BigInt maths and
 * can be done by every node and in the browser.
 */
export function verify(serial, signature, params) {
  const { n, e } = params;
  if (signature <= 0n || signature >= n) return false;
  return modPow(signature, e, n) === fullDomainHash(serial, params);
}

/* -------------------------------------------------------------- serials */

/** A credential serial: 32 bytes, and the only thing revealed when it is spent. */
export function newSerial() {
  return '0x' + randomBytes(32).toString('hex');
}

/**
 * The nullifier is the serial itself, and deliberately so.
 *
 * A credential is valid for exactly one voting place - the key says which - so
 * "this serial has been seen" is the whole double-spend rule. Hashing it with
 * the poll id would add a step and protect nothing, and a scheme with an
 * unnecessary step is a scheme with somewhere for a mistake to hide.
 */
export function nullifierOf(serial) {
  return String(serial).toLowerCase();
}
