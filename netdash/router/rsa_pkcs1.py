"""Minimal RSA PKCS#1 v1.5 encryption (public key only).

ZTE firmware signs every write request by RSA-encrypting the SHA-256 digest of
the exact form body with the public key embedded in its own pages. Python's
standard library has no RSA, so this module implements just enough DER parsing
and PKCS#1 v1.5 padding to reproduce that header without third-party packages.
"""

from __future__ import annotations

import base64
import secrets


def _read_tlv(data: bytes, pos: int) -> tuple[int, bytes, int]:
    tag = data[pos]
    pos += 1
    length = data[pos]
    pos += 1
    if length & 0x80:
        count = length & 0x7F
        length = int.from_bytes(data[pos : pos + count], "big")
        pos += count
    value = data[pos : pos + length]
    if len(value) != length:
        raise ValueError("truncated DER value")
    return tag, value, pos + length


class PublicKey:
    def __init__(self, modulus: int, exponent: int):
        self.n = modulus
        self.e = exponent
        self.size = (modulus.bit_length() + 7) // 8

    @classmethod
    def from_pem(cls, pem: str) -> "PublicKey":
        lines = [line.strip() for line in pem.strip().splitlines()]
        der = base64.b64decode("".join(line for line in lines if not line.startswith("-----")))
        _, outer, _ = _read_tlv(der, 0)
        # SubjectPublicKeyInfo = SEQUENCE { AlgorithmId, BIT STRING { RSAPublicKey } }
        _, _, pos = _read_tlv(outer, 0)
        _, bit_string, _ = _read_tlv(outer, pos)
        inner = bit_string[1:]  # first byte is the unused-bit count
        _, key_seq, _ = _read_tlv(inner, 0)
        _, n_bytes, kpos = _read_tlv(key_seq, 0)
        _, e_bytes, _ = _read_tlv(key_seq, kpos)
        return cls(int.from_bytes(n_bytes, "big"), int.from_bytes(e_bytes, "big"))

    def encrypt(self, message: bytes) -> str:
        """PKCS#1 v1.5 encrypt and return base64, like JSEncrypt does."""
        padding_len = self.size - len(message) - 3
        if padding_len < 8:
            raise ValueError("message too long for this key")
        padding = bytes(secrets.randbelow(255) + 1 for _ in range(padding_len))
        encoded = b"\x00\x02" + padding + b"\x00" + message
        number = pow(int.from_bytes(encoded, "big"), self.e, self.n)
        return base64.b64encode(number.to_bytes(self.size, "big")).decode("ascii")
