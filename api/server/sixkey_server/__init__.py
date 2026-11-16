"""Sixkey Phase 1 sync API (milestone M4 of docs/SYNC-DESIGN.md).

The contract is api/openapi.yaml. The server is zero-knowledge: it stores ciphertext, wrapped keys,
KDF parameters, versions, coarse timestamps, device public keys and the two verifiers, and checks
everything it can without a key (signatures, write proofs, verifiers, shapes, CAS).
"""
