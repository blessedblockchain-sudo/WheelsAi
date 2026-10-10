"use client";

import { useState, useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Wallet, LogOut, Copy, Check } from "lucide-react";

// Connects a wallet for this browser, shows its short address, copies it and
// disconnects. It asks the wallet to sign nothing: linking a wallet to the
// account is its own button in Settings, and paying is on the Billing page.
export function WalletButton() {
  const { publicKey, connected, disconnect } = useWallet();
  const { setVisible } = useWalletModal();
  const [copied, setCopied] = useState(false);

  const copyAddress = useCallback(() => {
    if (!publicKey) return;
    navigator.clipboard.writeText(publicKey.toBase58());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [publicKey]);

  const shortenedAddress = publicKey
    ? `${publicKey.toBase58().slice(0, 4)}...${publicKey.toBase58().slice(-4)}`
    : "";

  if (!connected) {
    return (
      <button
        onClick={() => setVisible(true)}
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
      >
        <Wallet className="h-5 w-5" />
        Connect Wallet
      </button>
    );
  }

  return (
    <div className="space-y-1">
      <button
        onClick={copyAddress}
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
        title="Copy address"
      >
        <Wallet className="h-5 w-5 text-green-600" />
        <span className="flex-1 text-left">
          <span className="block font-mono text-xs">{shortenedAddress}</span>
        </span>
        {copied ? (
          <Check className="h-3.5 w-3.5 text-green-500" />
        ) : (
          <Copy className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>
      <button
        onClick={() => disconnect()}
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-xs text-muted-foreground hover:bg-muted transition-colors"
      >
        <LogOut className="h-3.5 w-3.5" />
        Disconnect Wallet
      </button>
    </div>
  );
}
