#!/usr/bin/env python3
"""Account files for a local Solana test chain that stands in for devnet.

  make-accounts.py <out dir> <mint authority pubkey> [sol price in dollars]

local-chain.sh runs this before it starts the chain. It writes:
  usdc-mint.json   a token mint with 6 decimals at the address the API uses for
                   devnet USDC, whose mint authority is the given key, so test
                   wallets can be given "USDC" on the local chain.
  sol-price.json   (only with a price) a Pyth PriceUpdateV2 account at the real
                   SOL/USD address, owned by the Pyth receiver's address,
                   published "now". A loaded account never changes, so it goes
                   stale after SOL_PRICE_MAX_AGE_SECONDS: that is useful for
                   proving the "too old" refusal.
Nothing here touches a network.
"""
import base64, hashlib, json, struct, sys, time

ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
PYTH_ACCOUNT = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"
PYTH_RECEIVER = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"
FEED_ID = bytes.fromhex("ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d")


def b58decode32(text):
    n = 0
    for ch in text:
        n = n * 58 + ALPHA.index(ch)
    return n.to_bytes(32, "big")


def dump(pubkey, owner, data, lamports):
    return {"pubkey": pubkey, "account": {"lamports": lamports, "data": [base64.b64encode(data).decode(), "base64"],
                                           "owner": owner, "executable": False, "rentEpoch": 18446744073709551615,
                                           "space": len(data)}}


def main():
    out, authority = sys.argv[1], sys.argv[2]
    mint = struct.pack("<I", 1) + b58decode32(authority) + struct.pack("<Q", 0) + bytes([6, 1]) + struct.pack("<I", 0) + bytes(32)
    assert len(mint) == 82
    json.dump(dump(DEVNET_USDC_MINT, TOKEN_PROGRAM, mint, 1461600), open(f"{out}/usdc-mint.json", "w"))
    print("usdc-mint.json: mint", DEVNET_USDC_MINT, "authority", authority)
    if len(sys.argv) > 3:
        dollars = float(sys.argv[3])
        price = int(round(dollars * 10**8))
        conf = int(price * 0.0003)
        now = int(time.time())
        disc = hashlib.sha256(b"account:PriceUpdateV2").digest()[:8]
        body = disc + b58decode32(PYTH_ACCOUNT) + bytes([1]) + FEED_ID + struct.pack("<qQiqqqQ", price, conf, -8, now, now - 1, price, conf) + struct.pack("<Q", 1) + bytes(1)
        assert len(body) == 134, len(body)
        json.dump(dump(PYTH_ACCOUNT, PYTH_RECEIVER, body, 1825031), open(f"{out}/sol-price.json", "w"))
        print("sol-price.json: $%.2f published at %d" % (dollars, now))


if __name__ == "__main__":
    main()
