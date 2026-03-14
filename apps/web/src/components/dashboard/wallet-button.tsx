"use client";

import { useEffect, useState, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Wallet, LogOut, Copy, Check } from "lucide-react";
import { toast } from "sonner";
import { settingsApi } from "@/lib/api";

export function WalletButton() {
  const { publicKey, connected, disconnect, signMessage } = useWallet();
  const { connection } = useConnection();
  const { setVisible } = useWalletModal();
  const [balance, setBalance] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [linking, setLinking] = useState(false);

  // Fetch SOL balance when connected
  useEffect(() => {
    if (!publicKey || !connected) {
      setBalance(null);
      return;
    }

    let cancelled = false;

    const fetchBalance = async () => {
      try {
        const lamports = await connection.getBalance(publicKey);
        if (!cancelled) {
          setBalance(lamports / LAMPORTS_PER_SOL);
        }
      } catch {
        if (!cancelled) setBalance(null);
      }
    };

    fetchBalance();
    const interval = setInterval(fetchBalance, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [publicKey, connected, connection]);

  // Link wallet to account on connect
  useEffect(() => {
    if (!publicKey || !connected || !signMessage || linking) return;

    const linkWallet = async () => {
      setLinking(true);
      try {
        const address = publicKey.toBase58();
        const message = `Link wallet ${address} to WheelsAI account at ${Date.now()}`;
        const encoded = new TextEncoder().encode(message);
        const signature = await signMessage(encoded);
        const sigBase64 = Buffer.from(signature).toString("base64");
        await settingsApi.linkWallet(address, sigBase64, message);
      } catch {
        // Non-critical — user can still trade, just won't persist
      } finally {
        setLinking(false);
      }
    };

    linkWallet();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey, connected, signMessage]);

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
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 transition-colors"
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
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 transition-colors"
        title="Copy address"
      >
        <Wallet className="h-5 w-5 text-green-600" />
        <span className="flex-1 text-left">
          <span className="block font-mono text-xs">{shortenedAddress}</span>
          {balance !== null && (
            <span className="block text-xs text-gray-500">
              {balance.toFixed(4)} SOL
            </span>
          )}
        </span>
        {copied ? (
          <Check className="h-3.5 w-3.5 text-green-500" />
        ) : (
          <Copy className="h-3.5 w-3.5 text-gray-400" />
        )}
      </button>
      <button
        onClick={() => disconnect()}
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-xs text-gray-500 hover:bg-gray-100 transition-colors"
      >
        <LogOut className="h-3.5 w-3.5" />
        Disconnect Wallet
      </button>
    </div>
  );
}
