import { z } from "zod";
import { getSetting, setSetting } from "@/lib/settings";
import { DEFAULT_MODEL_MIN_CONTEXT } from "@/lib/constants";
import type { Control, ManageContext } from "../types";

/** Build an org-wide setting control over the existing key/value settings store.
 *  Every org control is admin-only and confirm-risk by construction, so a
 *  platform-wide change can never be applied from chat without a preview + an
 *  explicit second confirmation. */
function orgSetting(o: {
  key: string;
  title: string;
  description: string;
  schema: z.ZodType<string>;
  def: string;
  format?: (v: string) => string;
  impact?: (ctx: ManageContext, next: string) => Promise<string | undefined>;
}): Control {
  return {
    id: `org.${o.key}`,
    title: o.title,
    description: o.description,
    scope: "org",
    requiredRole: "admin",
    risk: "confirm",
    schema: o.schema,
    read: async () => (await getSetting(o.key)) ?? o.def,
    apply: async (_ctx, v) => {
      await setSetting(o.key, v);
    },
    format: o.format,
    impact: o.impact,
  };
}

const bool = z.enum(["true", "false"]);
const boolFmt = (v: string) => (v === "true" ? "Увімкнено" : "Вимкнено");
const int = z.string().regex(/^\d+$/, "Має бути цілим числом.");

export const orgControls: Control[] = [
  orgSetting({
    key: "platform_name",
    title: "Назва платформи",
    description: "Відображувана назва інсталяції.",
    schema: z.string().min(1, "Назва не може бути порожньою.").max(60, "Задовга назва (макс. 60)."),
    def: "Capka",
  }),
  orgSetting({
    key: "sandbox_enabled",
    title: "Пісочниця увімкнена",
    description: "Чи може агент виконувати код у Docker-пісочниці.",
    schema: bool,
    def: "true",
    format: boolFmt,
  }),
  orgSetting({
    key: "sandbox_network",
    title: "Мережа пісочниці",
    description: 'Доступ пісочниці до мережі: "none" (ізольовано) або "bridge" (є вихід у мережу).',
    schema: z.enum(["none", "bridge"]),
    def: "none",
    impact: async (_ctx, next) =>
      next === "bridge"
        ? "Пісочниці отримають вихід у мережу — і лише якщо на сервері виставлено SANDBOX_ALLOW_NETWORK=true."
        : undefined,
  }),
  orgSetting({
    key: "block_private_provider_urls",
    title: "Блокувати приватні URL провайдера",
    description: "Захист від SSRF: забороняти провайдерські базові URL, що вказують на приватну мережу.",
    schema: bool,
    def: "true",
    format: boolFmt,
    impact: async (_ctx, next) =>
      next === "false" ? "Вимкнення послаблює захист від SSRF — вмикайте лише свідомо." : undefined,
  }),
  orgSetting({
    key: "share_admin_providers",
    title: "Спільний ключ провайдера",
    description: "Чи використовують звичайні користувачі спільний ключ провайдера, підключений адміном.",
    schema: bool,
    def: "true",
    format: boolFmt,
  }),
  orgSetting({
    key: "members_can_install_plugins",
    title: "Учасники можуть ставити плагіни",
    description: "Дозволити звичайним користувачам самостійно встановлювати плагіни/скіли/конектори.",
    schema: bool,
    def: "false",
    format: boolFmt,
  }),
  orgSetting({
    key: "update_check_enabled",
    title: "Перевірка оновлень",
    description: "Періодично перевіряти наявність нових версій Capka.",
    schema: bool,
    def: "true",
    format: boolFmt,
  }),
  orgSetting({
    key: "model_min_context",
    title: "Мін. контекст моделі",
    description: "Приховувати моделі з контекстним вікном меншим за це значення (у токенах).",
    schema: int,
    def: String(DEFAULT_MODEL_MIN_CONTEXT),
  }),
  orgSetting({
    key: "max_context_tokens",
    title: "Ліміт контексту",
    description: 'Верхня межа токенів контексту на хід ("0" = авто, за моделлю).',
    schema: int,
    def: "0",
  }),
  orgSetting({
    key: "model_max_price",
    title: "Макс. ціна моделі",
    description: 'Приховувати моделі, дорожчі за це (за 1M токенів; "0" = без обмеження).',
    schema: z.string().regex(/^\d+(\.\d+)?$/, "Має бути числом."),
    def: "0",
  }),
];
