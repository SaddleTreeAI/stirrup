/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { ANDROID_APP_STORE_URL, IOS_APP_STORE_URL } from "@rakazo/contracts";
import { Link, Text } from "react-email";
import { emailText, greeting, linkStyle, message, withNodes } from "./email.js";

const APPS: Readonly<Record<string, string>> = {
  iPhone: IOS_APP_STORE_URL,
  Android: ANDROID_APP_STORE_URL,
  Mac: "https://stirrup.saddletree.ai/api/download?platform=mac",
  Windows: "https://stirrup.saddletree.ai/api/download?platform=windows",
  Linux: "https://stirrup.saddletree.ai/api/download?platform=linux",
};

const stepStyle = { margin: "20px 0 4px" };

export function welcomeEmail(
  user: { email: string; name: string },
  unsubscribeUrl: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  return message(
    user.email,
    locale,
    say("Welcome to Stirrup"),
    <>
      <Text>{greeting(say, user.name)}</Text>
      <Text>{say("Welcome to Stirrup")}</Text>
      <Text style={stepStyle}>
        <strong>{say("Get the apps")}</strong>
      </Text>
      <Text style={{ marginTop: 0 }}>
        {withNodes(
          say("Stirrup runs on {platforms}, so your stirrups can reach you wherever you are."),
          {
            // The language's own list ("A, B, and C", "A, B y C"), with each app a link.
            platforms: new Intl.ListFormat(locale, { type: "conjunction" })
              .formatToParts(Object.keys(APPS))
              .map((part, index) =>
                part.type === "element" ? (
                  <Link key={part.value} href={APPS[part.value]} style={linkStyle}>
                    {part.value}
                  </Link>
                ) : (
                  <span key={`${index}${part.value}`}>{part.value}</span>
                ),
              ),
          },
        )}
      </Text>
      <Text>
        <Link href="https://saddletree.ai/contact" style={linkStyle}>
          SaddleTree AI
        </Link>
      </Text>
    </>,
    unsubscribeUrl,
  );
}
