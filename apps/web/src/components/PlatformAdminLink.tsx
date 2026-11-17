import { Trans } from "@lingui/react/macro";
import { buttonVariants } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Shield } from "lucide-react";
import { Link } from "react-router-dom";
import { useSpaceQueries } from "../lib/query";

export function PlatformAdminLink() {
  const me = useQuery(useSpaceQueries().me.queryOptions());
  if (!me.data?.platformMode || !["owner", "admin"].includes(me.data.platformRole ?? "member"))
    return null;
  return (
    <Link
      to="/admin"
      className={`${buttonVariants({ variant: "ghost" })} h-9 w-full justify-start gap-2.5 font-normal`}
    >
      <Shield className="text-muted-foreground" strokeWidth={1.75} />
      <Trans>Administration</Trans>
    </Link>
  );
}
