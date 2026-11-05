import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

// One search database for every language; Unicode tokenization already covers Chinese.
export const dynamic = "force-static";
export const { staticGET: GET } = createFromSource(source);
