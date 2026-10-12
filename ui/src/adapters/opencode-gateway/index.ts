import type { UIAdapterModule } from "../types";
import {
  parseOpenCodeGatewayStdoutLine,
  buildOpenCodeGatewayConfig,
} from "@paperclipai/adapter-opencode-gateway/ui";
import { SchemaConfigFields } from "../schema-config-fields";

export const openCodeGatewayUIAdapter: UIAdapterModule = {
  type: "opencode_gateway",
  label: "OpenCode Gateway",
  parseStdoutLine: parseOpenCodeGatewayStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildOpenCodeGatewayConfig,
};
