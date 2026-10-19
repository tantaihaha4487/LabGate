import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Command,
  Eye,
  EyeOff,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Monitor,
  Moon,
  Plus,
  RefreshCw,
  Shield,
  Sun,
  Terminal,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { api, APIError, setCSRF, usePolling } from "./api";
import type { Machine, Page, Session } from "./api";
function ErrorNotice({ message }: { message: string }) {
  return message ? (
    <Alert variant="destructive">
      <AlertTitle>Something needs attention</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  ) : null;
}
function Status({ value }: { value: string }) {
  return (
    <Badge
      variant={
        value === "available" || value === "online" ? "secondary" : "outline"
      }
      className="gap-1.5 font-normal"
    >
      <span
        className={`size-1.5 rounded-full ${value === "available" || value === "online" ? "bg-emerald-500" : "bg-muted-foreground"}`}
      />
      {value.replaceAll("_", " ")}
    </Badge>
  );
}
function Empty({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center gap-3 text-center">
      <Monitor className="size-8 text-muted-foreground" />
      <h3 className="font-medium">{title}</h3>
      <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
function Loading() {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-48 rounded-xl" />
      ))}
    </div>
  );
}
function PairApproval() {
  const [code, setCode] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Card className="mx-auto max-w-lg">
      <CardHeader>
        <CardTitle>Connect your terminal</CardTitle>
        <CardDescription>
          Enter the pairing code displayed by labgate. Only approve a terminal
          you started yourself.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api("/api/cli/approve", "POST", { code: code.trim() });
              setDone(true);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Label htmlFor="pair-code">Pairing code</Label>
          <Input
            id="pair-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            autoComplete="off"
          />
          <ErrorNotice message={error} />
          {done ? (
            <p className="flex items-center gap-2 text-sm">
              <Check className="size-4" />
              Approved. Return to your terminal.
            </p>
          ) : (
            <Button disabled={busy}>Approve terminal</Button>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
type Credential = {
  username: string;
  password: string;
  expiresAt: string;
  serverTime: string;
  machineId: string;
  name: string;
  deadline: number;
};
function Students() {
  const { data, error, loading, refresh } = usePolling<{ machines: Machine[] }>(
    "/api/machines",
  );
  const [issued, setIssued] = useState<Credential>();
  const [remaining, setRemaining] = useState(0);
  const [result, setResult] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState("");
  const issuedMachine = issued?.machineId;
  const issuedDeadline = issued?.deadline;
  useEffect(() => {
    if (!issuedMachine || issuedDeadline === undefined) return;
    let pending = false;
    let finished = false;
    const update = async () => {
      const left = Math.max(
        0,
        Math.ceil((issuedDeadline - performance.now()) / 1000),
      );
      setRemaining(left);
      if (left === 0 && !pending && !finished) {
        setIssued((v) => (v ? { ...v, password: "" } : v));
        pending = true;
        try {
          const r = await api<{ status: string }>(
            "/api/checkout/expire",
            "POST",
            { machineId: issuedMachine },
          );
          setResult(
            r.status === "active"
              ? "Your physical session is active. Enjoy your lab time."
              : r.status === "held"
                ? "This machine is held for safety reconciliation."
                : "Your login window has ended.",
          );
          finished = r.status !== "retry";
        } catch (e) {
          setResult(
            e instanceof APIError && e.status === 503
              ? "The machine lock is pending. We’ll keep checking."
              : (e as Error).message,
          );
        } finally {
          pending = false;
        }
      }
    };
    void update();
    const t = setInterval(() => void update(), 1000);
    return () => clearInterval(t);
  }, [issuedMachine, issuedDeadline]);
  return (
    <>
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <p className="eyebrow">YOUR WORKSPACE</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            Find your next seat.
          </h1>
          <p className="mt-2 text-muted-foreground">
            Reserve a physical desktop, then sign in with its temporary guest
            password.
          </p>
        </div>
        <Button
          variant="outline"
          size="icon"
          aria-label="Refresh machines"
          onClick={() => void refresh()}
        >
          <RefreshCw className="size-4" />
        </Button>
      </div>
      <ErrorNotice message={error || actionError} />
      {issued && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>{issued.name}</CardTitle>
            <CardDescription>
              Sign in at the physical keyboard. Your password is shown once.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {issued.password && remaining > 0 ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <p className="text-xs text-muted-foreground">Username</p>
                    <p className="mt-1 font-mono text-lg">guest</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">
                      Temporary password
                    </p>
                    <p className="mt-1 font-mono text-2xl tracking-wider select-all">
                      {issued.password}
                    </p>
                  </div>
                </div>
                <p className="flex items-center gap-2 text-sm">
                  <Clock className="size-4" />
                  Login within {Math.floor(remaining / 60)}:
                  {String(remaining % 60).padStart(2, "0")}
                </p>
              </>
            ) : (
              <p>{result || "Checking machine safety…"}</p>
            )}
            <p className="text-xs text-muted-foreground">
              The deadline is for your first login. An active desktop session
              has no time limit.
            </p>
          </CardContent>
        </Card>
      )}
      {loading && !data ? (
        <Loading />
      ) : !data?.machines.length ? (
        <Empty
          title="No desktops listed"
          description="Your administrator will make lab machines available here."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.machines.map((m) => (
            <Card key={m.id}>
              <CardHeader className="flex-row items-center justify-between">
                <div className="flex size-11 items-center justify-center rounded-lg bg-muted">
                  <Monitor className="size-5" />
                </div>
                <Status value={m.connectivity} />
              </CardHeader>
              <CardContent>
                <h2 className="text-xl font-medium">{m.name}</h2>
                <div className="mt-2">
                  <Status value={m.status} />
                </div>
                <Button
                  className="mt-7 w-full justify-between"
                  disabled={
                    busy !== "" ||
                    m.status !== "available" ||
                    m.connectivity !== "online"
                  }
                  onClick={async () => {
                    setBusy(m.id);
                    setActionError("");
                    try {
                      const r = await api<
                        Omit<Credential, "machineId" | "name" | "deadline">
                      >("/api/checkout", "POST", { machineId: m.id });
                      const delta =
                        Date.parse(r.expiresAt) - Date.parse(r.serverTime);
                      setIssued({
                        ...r,
                        machineId: m.id,
                        name: m.name,
                        deadline: performance.now() + delta,
                      });
                      setRemaining(Math.ceil(delta / 1000));
                      setResult("");
                      void refresh();
                    } catch (e) {
                      setActionError((e as Error).message);
                    } finally {
                      setBusy("");
                    }
                  }}
                >
                  {busy === m.id ? "Preparing desktop…" : "Reserve desktop"}
                  <ArrowRight className="size-4" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
function AdminMachines() {
  const { data, error, loading, refresh } = usePolling<{ machines: Machine[] }>(
    "/api/admin/machines",
  );
  const [confirm, setConfirm] = useState<Machine>();
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const machines = data?.machines ?? [];
  return (
    <>
      <PageTitle
        eyebrow="LAB OVERVIEW"
        title="Every desktop. One place."
        description="See reservations, connection health, and machines that need attention."
        onRefresh={() => void refresh()}
      />
      <ErrorNotice message={error || actionError} />
      <div className="my-6 grid gap-4 sm:grid-cols-3">
        {[
          ["Total desktops", machines.length],
          [
            "Available",
            machines.filter(
              (m) => m.status === "available" && m.connectivity === "online",
            ).length,
          ],
          [
            "Safety holds",
            machines.filter((m) => m.safetyHoldCredentialId).length,
          ],
        ].map(([label, value]) => (
          <Card key={label}>
            <CardContent className="pt-5">
              <p className="text-sm text-muted-foreground">{label}</p>
              <p className="mt-2 text-3xl font-semibold tracking-tight">
                {value}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader className="gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>Machine inventory</CardTitle>
            <CardDescription>
              Updates every two seconds. Hidden desktops remain managed.
            </CardDescription>
          </div>
          <Input
            className="sm:max-w-64"
            aria-label="Search machines"
            placeholder="Find a desktop…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </CardHeader>
        <CardContent>
          {loading && !data ? (
            <Loading />
          ) : machines.length === 0 ? (
            <Empty
              title="Your lab starts here"
              description="Open Enrollment to register your first desktop."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Desktop</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Reservation</TableHead>
                  <TableHead>Visibility</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {machines
                  .filter((m) =>
                    m.name.toLowerCase().includes(search.toLowerCase()),
                  )
                  .map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>
                        <p className="font-medium">{m.name}</p>
                        <p className="mt-1 font-mono text-xs text-muted-foreground">
                          {m.tailscaleIp}
                        </p>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          <Status value={m.status} />
                          <Status value={m.connectivity} />
                        </div>
                        {m.safetyHoldCredentialId && (
                          <p className="mt-1 text-xs text-destructive">
                            Safety hold · {m.safetyHoldCredentialId}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        {m.currentReservation ? (
                          <>
                            <p className="text-sm">
                              {m.currentReservation.studentEmail}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {m.currentReservation.state} ·{" "}
                              {new Date(
                                m.currentReservation.expiresAt,
                              ).toLocaleString()}
                            </p>
                          </>
                        ) : (
                          <span className="text-muted-foreground">
                            No reservation
                          </span>
                        )}
                      </TableCell>
                      <TableCell>{m.isHidden ? "Hidden" : "Visible"}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setConfirm(m)}
                        >
                          {m.isHidden ? (
                            <Eye className="size-3.5" />
                          ) : (
                            <EyeOff className="size-3.5" />
                          )}
                          {m.isHidden ? "Restore" : "Hide"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <AlertDialog
        open={!!confirm}
        onOpenChange={(v) => {
          if (!v && !busy) setConfirm(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.isHidden ? "Restore" : "Hide"} {confirm?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This changes student visibility. Reservations and machine safety
              state are preserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={async (e) => {
                e.preventDefault();
                if (!confirm) return;
                setBusy(true);
                try {
                  await api(
                    `/api/admin/machines/${confirm.id}/visibility`,
                    "PATCH",
                    { hidden: !confirm.isHidden },
                  );
                  setConfirm(undefined);
                  void refresh();
                } catch (e) {
                  setActionError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
function PageTitle({
  eyebrow,
  title,
  description,
  onRefresh,
}: {
  eyebrow: string;
  title: string;
  description: string;
  onRefresh?: () => void;
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-muted-foreground">{description}</p>
      </div>
      {onRefresh && (
        <Button
          variant="outline"
          size="icon"
          aria-label="Refresh"
          onClick={onRefresh}
        >
          <RefreshCw className="size-4" />
        </Button>
      )}
    </div>
  );
}
function Activity() {
  const [source, setSource] = useState("all");
  const [action, setAction] = useState("all");
  const [email, setEmail] = useState("");
  const [emailFilter, setEmailFilter] = useState("");
  const [cursors, setCursors] = useState<string[]>([""]);
  const cursor = cursors.at(-1) ?? "";
  const p = new URLSearchParams({ source, action });
  if (emailFilter) p.set("email", emailFilter);
  if (cursor) p.set("cursor", cursor);
  const { data, error, loading, refresh } = usePolling<Page>(
    "/api/admin/logs?" + p.toString(),
    true,
    cursor ? 3600000 : 2000,
  );
  const reset = () => setCursors([""]);
  return (
    <>
      <PageTitle
        eyebrow="AUDIT TRAIL"
        title="A clear picture of your lab."
        description="Reservations, web sign-ins, and physical desktop sessions, in order."
        onRefresh={() => void refresh()}
      />
      <ErrorNotice message={error} />
      <Card>
        <CardHeader>
          <CardTitle>Activity</CardTitle>
          <div className="mt-3 flex flex-wrap gap-3">
            <Select
              value={source}
              onValueChange={(v) => {
                setSource(v);
                reset();
              }}
            >
              <SelectTrigger aria-label="Activity source" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["all", "web", "physical"].map((v) => (
                  <SelectItem key={v} value={v}>
                    {v === "all" ? "All sources" : v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={action}
              onValueChange={(v) => {
                setAction(v);
                reset();
              }}
            >
              <SelectTrigger aria-label="Activity action" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["all", "checkout", "login", "logout", "timeout"].map((v) => (
                  <SelectItem key={v} value={v}>
                    {v === "all" ? "All actions" : v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <form
              className="flex flex-1 gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setEmailFilter(email.trim());
                reset();
              }}
            >
              <Input
                aria-label="Filter by exact email"
                placeholder="Exact student email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Button variant="outline">Filter</Button>
            </form>
          </div>
        </CardHeader>
        <CardContent>
          {loading && !data ? (
            <Loading />
          ) : !data?.entries.length ? (
            <Empty
              title="Nothing here yet"
              description="Activity will appear when someone signs in or uses a lab desktop."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time (UTC)</TableHead>
                  <TableHead>Student</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Desktop</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.entries.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      {v.occurredAt.replace("T", " ").replace(".000Z", "")}
                    </TableCell>
                    <TableCell>{v.email}</TableCell>
                    <TableCell>
                      <Status value={v.status} />
                    </TableCell>
                    <TableCell>{v.source}</TableCell>
                    <TableCell>{v.machine?.name ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={cursors.length === 1}
              onClick={() => setCursors((v) => v.slice(0, -1))}
            >
              <ChevronLeft className="size-4" />
              Newer
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!data?.nextCursor}
              onClick={() => {
                if (data?.nextCursor)
                  setCursors((v) => [...v, data.nextCursor!]);
              }}
            >
              Older
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
function Enrollment() {
  const { data } = usePolling<{ machines: Machine[] }>("/api/admin/machines");
  const [target, setTarget] = useState("new");
  const [name, setName] = useState("");
  const [ip, setIP] = useState("");
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = data?.machines.find((m) => m.id === target);
  return (
    <>
      <PageTitle
        eyebrow="ENROLLMENT"
        title="Bring a desktop into your lab."
        description="Register a new machine or replace the identity of a drained one."
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_0.8fr]">
        <Card>
          <CardHeader>
            <CardTitle>Machine identity</CardTitle>
            <CardDescription>
              A machine becomes available only after a safe authenticated
              heartbeat.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-5"
              onSubmit={(e) => {
                e.preventDefault();
                setConfirm(true);
              }}
            >
              <div className="space-y-2">
                <Label>Operation</Label>
                <Select
                  value={target}
                  onValueChange={(v) => {
                    setTarget(v);
                    const m = data?.machines.find((x) => x.id === v);
                    setName(m?.name ?? "");
                    setIP(m?.tailscaleIp ?? "");
                    setPin(m?.sshHostKeySha256 ?? "");
                  }}
                >
                  <SelectTrigger aria-label="Enrollment operation">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="new">Enroll a new machine</SelectItem>
                    {data?.machines.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        Rekey: {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {[
                ["Machine name", name, setName],
                ["Tailscale IPv4", ip, setIP],
                ["Ed25519 SSH host-key fingerprint", pin, setPin],
              ].map(([label, value, setter], i) => (
                <div key={i} className="space-y-2">
                  <Label htmlFor={"identity-" + i}>{label as string}</Label>
                  <Input
                    id={"identity-" + i}
                    value={value as string}
                    onChange={(e) =>
                      (setter as (s: string) => void)(e.target.value)
                    }
                    required
                    placeholder={
                      i === 1
                        ? "100.x.x.x"
                        : i === 2
                          ? "SHA256:…"
                          : "Lab desktop 01"
                    }
                  />
                </div>
              ))}
              <ErrorNotice message={error} />
              <Button disabled={busy}>
                <Plus className="size-4" />
                {target === "new" ? "Register desktop" : "Rekey desktop"}
              </Button>
            </form>
          </CardContent>
        </Card>
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Install on the desktop</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm text-muted-foreground">
            <p>
              Use the release installer and select{" "}
              <strong className="text-foreground">Lab machine</strong>. It
              guides Tailscale connectivity, PAM setup, and enrollment.
            </p>
            <p>Server address</p>
            <code className="block break-all rounded-md bg-muted p-3 text-foreground">
              {location.origin}
            </code>
            <p>
              For rekey, first drain the desktop. Its existing name, address,
              and fingerprint must still match; active reservations and safety
              holds block replacement.
            </p>
            <p>
              Install any returned token only in the machine’s root-only
              configuration. Wait for a safe heartbeat before checkout.
            </p>
          </CardContent>
        </Card>
      </div>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {target === "new" ? "Register" : "Rekey"} {name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {target === "new"
                ? "The new machine starts offline."
                : "The machine must be drained. Its token will be replaced and it will stay offline until the new identity reports a safe heartbeat."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  const body = {
                    name,
                    tailscaleIp: ip,
                    sshHostKeySha256: pin,
                    ...(selected
                      ? {
                          machineId: selected.id,
                          expectedName: selected.name,
                          expectedTailscaleIp: selected.tailscaleIp,
                          expectedSshHostKeySha256: selected.sshHostKeySha256,
                        }
                      : {}),
                  };
                  const v = await api<{ webhookToken: string }>(
                    "/api/admin/register-machine",
                    selected ? "PATCH" : "POST",
                    body,
                  );
                  setSecret(v.webhookToken);
                  setConfirm(false);
                  setError("");
                } catch (e) {
                  setError((e as Error).message);
                  setConfirm(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog
        open={!!secret}
        onOpenChange={(v) => {
          if (!v) setSecret("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enrollment token</DialogTitle>
            <DialogDescription>
              Install this token in the machine’s root-only configuration. This
              dialog clears it when closed.
            </DialogDescription>
          </DialogHeader>
          <p className="break-all rounded-md bg-muted p-4 font-mono text-sm select-all">
            {secret}
          </p>
          <Button onClick={() => setSecret("")}>Done</Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
function Administrators({ session }: { session: Session }) {
  const [emails, setEmails] = useState((session.adminEmails ?? []).join(","));
  const [line, setLine] = useState("");
  const [error, setError] = useState("");
  const domain = session.user.email.split("@")[1];
  return (
    <>
      <PageTitle
        eyebrow="ACCESS"
        title="The right people in charge."
        description="Administrator access is controlled by the server’s configured email allowlist."
      />
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Configured administrators</CardTitle>
          <CardDescription>
            Exact institutional accounts, validated by the server.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {session.adminEmails?.map((v) => (
            <div key={v} className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-full bg-muted">
                <Shield className="size-4" />
              </div>
              <span className="text-sm">{v}</span>
            </div>
          ))}
          <form
            className="space-y-3 border-t pt-5"
            onSubmit={(e) => {
              e.preventDefault();
              const values = emails
                .split(",")
                .map((v) => v.trim().toLowerCase());
              if (
                values.some(
                  (v) =>
                    !v.endsWith("@" + domain) ||
                    v.split("@").length !== 2 ||
                    /[\s"']/.test(v),
                )
              ) {
                setError(
                  "Use exact institutional email addresses, separated by commas.",
                );
                return;
              }
              setError("");
              setLine("ADMIN_EMAILS=" + [...new Set(values)].join(","));
            }}
          >
            <Label htmlFor="admins">Administrator email list</Label>
            <Input
              id="admins"
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
            />
            <ErrorNotice message={error} />
            <Button variant="outline">Generate configuration line</Button>
          </form>
          {line && (
            <>
              <code className="block break-all rounded-md bg-muted p-3 text-sm select-all">
                {line}
              </code>
              <p className="text-sm text-muted-foreground">
                Apply the list using server setup and restart the service.
                Generating this line does not change access.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}
function App() {
  const [session, setSession] = useState<Session | null>();
  const [error, setError] = useState("");
  const [path, setPath] = useState(location.pathname);
  const [dark, setDark] = useState(
    () => localStorage.getItem("labgate-theme") !== "light",
  );
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("labgate-theme", dark ? "dark" : "light");
  }, [dark]);
  useEffect(() => {
    api<Session>("/api/session")
      .then((s) => {
        setCSRF(s.csrfToken);
        setSession(s);
      })
      .catch((e) => {
        if (!(e instanceof APIError && e.status === 401)) setError(e.message);
        setSession(null);
      });
    const pop = () => setPath(location.pathname);
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  function navigate(p: string) {
    history.pushState(null, "", p);
    setPath(p);
  }
  const theme = (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle theme"
      onClick={() => setDark((v) => !v)}
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
  if (session === undefined)
    return (
      <main className="mx-auto max-w-6xl p-8">
        <Loading />
      </main>
    );
  if (!session)
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="absolute right-6 top-6">{theme}</div>
        <Card className="w-full max-w-md">
          <CardHeader className="pb-6">
            <div className="mb-6 flex size-12 items-center justify-center rounded-xl bg-foreground text-background">
              <Monitor className="size-6" />
            </div>
            <p className="eyebrow">LABGATE</p>
            <CardTitle className="mt-2 text-3xl tracking-tight">
              Your lab, ready when you are.
            </CardTitle>
            <CardDescription className="mt-2">
              Sign in with your university Google account to reserve a physical
              desktop.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <ErrorNotice message={error} />
            <Button asChild className="w-full">
              <a href="/api/auth/sign-in/google">
                Continue with Google
                <ArrowRight className="size-4" />
              </a>
            </Button>
            <p className="text-xs leading-relaxed text-muted-foreground">
              A temporary guest password. A real desktop. Your active session
              stays yours until you sign out at the machine.
            </p>
          </CardContent>
        </Card>
      </main>
    );
  const admin = path.startsWith("/admin");
  const links = [
    ["/admin", "Overview", LayoutDashboard],
    ["/admin/logs", "Activity", Clock],
    ["/admin/enrollment", "Enrollment", KeyRound],
    ["/admin/administrators", "Administrators", Users],
  ] as const;
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b bg-background/95 px-5 md:px-8">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate("/");
          }}
          className="flex items-center gap-2.5 font-semibold tracking-tight"
        >
          <div className="flex size-8 items-center justify-center rounded-lg bg-foreground text-background">
            <Monitor className="size-4" />
          </div>
          LabGate
        </a>
        <div className="flex items-center gap-2">
          {session.isAdmin && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate(admin ? "/" : "/admin")}
            >
              {admin ? "Student view" : "Administration"}
            </Button>
          )}
          {theme}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Sign out"
            onClick={async () => {
              try {
                await api("/api/auth/sign-out", "POST", {});
                setSession(null);
                setCSRF("");
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <LogOut className="size-4" />
          </Button>
        </div>
      </header>
      <div
        className={`mx-auto flex max-w-[1500px] ${admin ? "" : "max-w-6xl"}`}
      >
        {admin && session.isAdmin && (
          <aside className="hidden min-h-[calc(100vh-4rem)] w-60 shrink-0 border-r p-5 md:flex md:flex-col">
            <p className="eyebrow mb-5 px-3">ADMINISTRATION</p>
            <nav className="space-y-1">
              {links.map(([href, label, Icon]) => (
                <Button
                  key={href}
                  variant={path === href ? "secondary" : "ghost"}
                  className="w-full justify-start gap-3"
                  onClick={() => navigate(href)}
                >
                  <Icon className="size-4" />
                  {label}
                </Button>
              ))}
            </nav>
            <div className="mt-auto pt-12">
              <div className="rounded-lg border p-3 text-xs text-muted-foreground">
                <Terminal className="mb-2 size-4" />
                <p>Prefer the terminal?</p>
                <code className="mt-1 block text-foreground">labgate</code>
              </div>
              <p className="mt-4 break-all px-1 text-xs text-muted-foreground">
                {session.user.email}
              </p>
            </div>
          </aside>
        )}
        <main className="min-w-0 flex-1 px-5 py-8 md:p-9 lg:p-12">
          {admin && session.isAdmin && (
            <nav className="mb-6 flex flex-wrap gap-2 md:hidden">
              {links.map(([href, label]) => (
                <Button
                  key={href}
                  size="sm"
                  variant={path === href ? "secondary" : "ghost"}
                  onClick={() => navigate(href)}
                >
                  {label}
                </Button>
              ))}
            </nav>
          )}
          <ErrorNotice message={error} />
          {path === "/cli/approve" ? (
            session.isAdmin ? (
              <PairApproval />
            ) : (
              <ErrorNotice message="Administrator access is required." />
            )
          ) : admin ? (
            session.isAdmin ? (
              path === "/admin/logs" ? (
                <Activity />
              ) : path === "/admin/enrollment" ? (
                <Enrollment />
              ) : path === "/admin/administrators" ? (
                <Administrators session={session} />
              ) : (
                <AdminMachines />
              )
            ) : (
              <ErrorNotice message="Administrator access is required." />
            )
          ) : (
            <Students />
          )}
          <footer className="mt-14 flex items-center gap-2 border-t pt-5 text-xs text-muted-foreground">
            <Command className="size-3" />
            LabGate · Physical desktops, safely shared.
          </footer>
        </main>
      </div>
    </div>
  );
}
export default App;
