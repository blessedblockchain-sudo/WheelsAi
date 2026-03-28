import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";

export const runtime = "edge";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const title = searchParams.get("title") || "Build, Deploy & Monetize AI Agents";
  const description =
    searchParams.get("description") ||
    "One platform. Any framework. 10+ channels. 90% revenue.";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          background: "linear-gradient(135deg, #040a18 0%, #0f1b3d 50%, #1a0a2e 100%)",
          fontFamily: "Inter, system-ui, sans-serif",
          padding: "60px",
        }}
      >
        {/* Logo area */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "16px",
            marginBottom: "40px",
          }}
        >
          <div
            style={{
              width: "56px",
              height: "56px",
              borderRadius: "14px",
              background: "linear-gradient(135deg, #3b82f6, #8b5cf6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "28px",
              color: "white",
              fontWeight: 700,
            }}
          >
            W
          </div>
          <span
            style={{
              fontSize: "32px",
              fontWeight: 700,
              color: "white",
            }}
          >
            WheelsAI
          </span>
        </div>

        {/* Title */}
        <div
          style={{
            fontSize: "52px",
            fontWeight: 800,
            color: "white",
            textAlign: "center",
            lineHeight: 1.2,
            maxWidth: "900px",
            marginBottom: "24px",
          }}
        >
          {title}
        </div>

        {/* Description */}
        <div
          style={{
            fontSize: "24px",
            color: "rgba(147, 197, 253, 0.7)",
            textAlign: "center",
            maxWidth: "700px",
            lineHeight: 1.5,
          }}
        >
          {description}
        </div>

        {/* Bottom badges */}
        <div
          style={{
            display: "flex",
            gap: "20px",
            marginTop: "48px",
          }}
        >
          {["6+ Frameworks", "10+ Channels", "90% Revenue"].map((badge) => (
            <div
              key={badge}
              style={{
                padding: "10px 24px",
                borderRadius: "999px",
                border: "1px solid rgba(59, 130, 246, 0.3)",
                background: "rgba(59, 130, 246, 0.1)",
                color: "rgba(147, 197, 253, 0.9)",
                fontSize: "16px",
                fontWeight: 600,
              }}
            >
              {badge}
            </div>
          ))}
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    }
  );
}
