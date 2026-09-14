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
      width: 384,
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
          <span className="hidden sm:inline">订阅二维码</span>
        </Button>

          <div className="invisible absolute bottom-full left-1/2 z-50 -translate-x-1/2 pb-2 opacity-0 transition-opacity duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">          <div className="w-max rounded-xl border border-white/10 bg-[#111318] p-3 shadow-2xl">
            <div className="mb-2 whitespace-nowrap text-center text-xs text-white/60">

            </div>

            <div className="shrink-0 rounded-md bg-white p-[2mm]">
              {qrDataUrl ? (
                  <Image
                      src={qrDataUrl}
                      alt="订阅链接二维码"
                      width={384}
                      height={384}
                      unoptimized
                      className="block h-[28mm] w-[28mm] min-h-[28mm] min-w-[28mm] max-w-none object-contain"
                  />
              ) : (
                  <div className="flex h-[28mm] w-[28mm] min-h-[28mm] min-w-[28mm] shrink-0 items-center justify-center text-[10px] text-black/60">
                    生成中
                  </div>
              )}
            </div>
          </div>
        </div>
      </div>
  );
}