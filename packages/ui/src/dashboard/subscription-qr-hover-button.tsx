"use client";

import * as React from "react";
import Image from "next/image";
import { QrCode } from "lucide-react";
import QRCode from "qrcode";

import { Button } from "@subboost/ui/components/ui/button";

type Props = {
  subscriptionUrl: string;
};

export function SubscriptionQrHoverButton({ subscriptionUrl }: Props) {
  const [qrDataUrl, setQrDataUrl] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;

    if (!subscriptionUrl) {
      setQrDataUrl("");
      return;
    }

    QRCode.toDataURL(subscriptionUrl, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 256,
    })
      .then((dataUrl) => {
        if (!cancelled) {
          setQrDataUrl(dataUrl);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setQrDataUrl("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [subscriptionUrl]);

  return (
    <div className="group relative inline-flex">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="gap-0 sm:gap-2"
        title="查看订阅二维码"
        aria-label="查看订阅二维码"
      >
        <QrCode className="h-4 w-4" />
        <span className="hidden sm:inline">二维码</span>
      </Button>

      <div className="invisible absolute right-0 top-full z-50 mt-2 opacity-0 transition-opacity duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
        <div className="rounded-xl border border-white/10 bg-[#111318] p-3 shadow-2xl">
          <div className="mb-2 whitespace-nowrap text-center text-xs text-white/60">
            查看二维码
          </div>

          <div className="rounded-md bg-white p-[2mm]">
            {qrDataUrl ? (
              <Image
                src={qrDataUrl}
                alt="订阅链接二维码"
                width={256}
                height={256}
                unoptimized
                className="block"
                style={{
                  width: "20mm",
                  height: "20mm",
                }}
              />
            ) : (
              <div
                className="flex items-center justify-center text-[10px] text-black/60"
                style={{
                  width: "20mm",
                  height: "20mm",
                }}
              >
                生成中
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
