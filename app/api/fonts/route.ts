import { NextResponse } from "next/server";
import { getFonts } from "@/lib/fonts";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ fonts: await getFonts() });
}
