import { COMPANY_URL, SELF_HOST_GUIDE_PATH, SITE_URL } from "./site";

export type PricingPlan = {
  name: string;
  price: string;
  note?: string;
  features: string[];
  action: { label: string; href: string };
};

export const PRICING_PLANS: PricingPlan[] = [
  {
    name: "Self-hosted",
    price: "Free",
    note: "You cover your infrastructure and model usage.",
    features: [
      "Open source, Apache-2.0",
      "Your server or your own computer",
      "Stirrup computers in Docker or a sandbox",
      "Any model you connect",
    ],
    action: { label: "Self-hosting guide", href: SELF_HOST_GUIDE_PATH },
  },
  {
    name: "Deployment and support",
    price: "Contact SaddleTree",
    features: ["Discuss your team's requirements", "Agree on scope and pricing before starting"],
    action: { label: "Contact SaddleTree", href: `${COMPANY_URL}/contact` },
  },
];

export const PRICING_MARKDOWN = `# Stirrup pricing

${PRICING_PLANS.map((plan) => `## ${plan.name}

${plan.price}${plan.note ? ` — ${plan.note}` : ""}

${plan.features.map((feature) => `- ${feature}`).join("\n")}

[${plan.action.label}](${new URL(plan.action.href, SITE_URL).href})`).join("\n\n")}
`;

export const PRICE_OFFERS = [{ name: "Self-hosted", monthlyCents: 0 }];
