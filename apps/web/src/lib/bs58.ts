/**
 * base58 encoding, for the one value that needs it in the browser.
 *
 * A wallet returns a 64-byte signature as a `Uint8Array` and the API expects
 * base58, which is what every Solana tool speaks. That is the ONLY conversion
 * this app performs, and importing a package for it would add a dependency —
 * and a supply-chain edge — to the code path whose entire job is proving who
 * somebody is.
 *
 * The leading-zero handling is the part implementations get wrong: base58 has
 * no way to represent a leading zero byte positionally, so each one is emitted
 * as an explicit '1'. Dropping them produces a shorter string that decodes to a
 * different value.
 */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export default function bs58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';

  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = '';
  // One '1' per leading zero byte — see the note above.
  for (let i = 0; i < bytes.length && bytes[i] === 0; i += 1) out += ALPHABET[0];
  for (let i = digits.length - 1; i >= 0; i -= 1) out += ALPHABET[digits[i]!];
  return out;
}
