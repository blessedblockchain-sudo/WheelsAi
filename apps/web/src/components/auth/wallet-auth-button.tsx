"use client";

import { useEffect, useRef, useState, useId } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { toast } from "sonner";
import bs58 from "bs58";

import { Button } from "@/components/ui/button";
import { authApi, isTwoFactorChallenge } from "@/lib/api";

export function WalletAuthButton() {
  const router = useRouter();
  const { publicKey, signMessage, disconnect, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  // Prevent double-execution when effect fires with a stable publicKey
  const hasAttemptedRef = useRef(false);
  // Track whether this component is still mounted
  const isMountedRef = useRef(true);

  const gradientId = useId();

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // Only run when a wallet becomes connected and we haven't started the flow yet
    if (!connected || !publicKey || hasAttemptedRef.current) return;

    hasAttemptedRef.current = true;

    async function authenticate() {
      if (!publicKey || !signMessage) {
        toast.error("Wallet does not support message signing.");
        return;
      }

      if (!isMountedRef.current) return;
      setIsAuthenticating(true);

      try {
        // Step 1: Request a nonce for this wallet address
        const { nonce } = await authApi.walletNonce(publicKey.toBase58());

        if (!isMountedRef.current) return;

        // Step 2: Sign the nonce — backend uses new TextEncoder().encode(nonce)
        const messageBytes = new TextEncoder().encode(nonce);
        const signatureBytes = await signMessage(messageBytes);

        if (!isMountedRef.current) return;

        // Step 3: Base58-encode the raw signature bytes (backend does bs58.decode)
        const signatureBase58 = bs58.encode(signatureBytes);

        // Step 4: Verify with the backend
        const res = await authApi.walletVerify(
          publicKey.toBase58(),
          signatureBase58,
          nonce,
        );

        if (!isMountedRef.current) return;

        if (isTwoFactorChallenge(res)) {
          // 2FA is enabled on this account: the signature alone does not
          // sign you in. Hand off to the dedicated verification step.
          toast.info("Enter your authentication code to finish signing in.");
          router.push(
            `/login?challenge=${encodeURIComponent(res.challengeToken)}`,
          );
          return;
        }

        toast.success("Wallet connected!");
        router.push("/dashboard");
      } catch (err) {
        if (!isMountedRef.current) return;

        const message =
          err instanceof Error ? err.message : "Wallet authentication failed.";
        toast.error(message);

        // Reset so the user can try again
        hasAttemptedRef.current = false;
        disconnect().catch(() => undefined);
      } finally {
        if (isMountedRef.current) {
          setIsAuthenticating(false);
        }
      }
    }

    authenticate();
  }, [connected, publicKey, signMessage, disconnect, router]);

  function handleClick() {
    // Reset the attempt guard so a fresh wallet connection triggers auth
    hasAttemptedRef.current = false;
    setVisible(true);
  }

  return (
    <Button
      variant="outline"
      className="mt-4 w-full"
      onClick={handleClick}
      isLoading={isAuthenticating}
      disabled={isAuthenticating}
    >
      {!isAuthenticating && (
        <svg className="mr-2 h-5 w-5" viewBox="0 0 32 32" fill="none">
          <circle cx="16" cy="16" r="16" fill={`url(#${gradientId})`} />
          <path
            d="M10.5 19.5L14 16L10.5 12.5M17.5 19.5L21 16L17.5 12.5"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <defs>
            <linearGradient
              id={gradientId}
              x1="0"
              y1="0"
              x2="32"
              y2="32"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="#00FFA3" />
              <stop offset="1" stopColor="#DC1FFF" />
            </linearGradient>
          </defs>
        </svg>
      )}
      {isAuthenticating ? "Connecting..." : "Connect Solana Wallet"}
    </Button>
  );
}
