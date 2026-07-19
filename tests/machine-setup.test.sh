#!/usr/bin/env bash

# Rootless regression tests for the machine-side credential protocol. The
# production scripts keep their installed absolute paths; a private user and
# mount namespace binds disposable fixtures over those paths so the host guest
# account, PAM configuration, mounts, and lifecycle state are never touched.

set -u -o pipefail

readonly TEST_SCRIPT=$(readlink -f -- "${BASH_SOURCE[0]}")
readonly REPOSITORY_ROOT=$(cd -- "$(dirname -- "${TEST_SCRIPT}")/.." && pwd)

prepare_fixture() {
  local fixture=$1 command

  mkdir -p \
    "${fixture}/control" \
    "${fixture}/rootfs/etc/labgate" \
    "${fixture}/rootfs/etc/pam.d" \
    "${fixture}/rootfs/etc/ssh" \
    "${fixture}/rootfs/home/guest" \
    "${fixture}/rootfs/run/labgate" \
    "${fixture}/rootfs/run/lock" \
    "${fixture}/rootfs/run/user" \
    "${fixture}/scratch/dev-shm" \
    "${fixture}/scratch/mqueue" \
    "${fixture}/scratch/mail" \
    "${fixture}/scratch/tmp" \
    "${fixture}/scratch/var-tmp" \
    "${fixture}/source/machine-setup" \
    "${fixture}/usr-local-lib/labgate" \
    "${fixture}/usr-local-sbin" \
    "${fixture}/rootfs/var-lib/labgate" \
    "${fixture}/rootfs/var-lib/systemd/linger"

  printf 'root:x:0:0:root:/root:/bin/sh\nguest:x:0:0:guest:/home/guest:/bin/bash\n' \
    >"${fixture}/rootfs/etc/passwd"
  printf 'root:x:0:\nguest:x:0:\n' >"${fixture}/rootfs/etc/group"
  printf 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILabGateTestOnly root@test\n' \
    >"${fixture}/rootfs/etc/ssh/ssh_host_ed25519_key.pub"
  chmod 0644 "${fixture}/rootfs/etc/ssh/ssh_host_ed25519_key.pub"

  install -m 0600 \
    "${REPOSITORY_ROOT}/machine-setup/labgate-common.sh" \
    "${fixture}/usr-local-lib/labgate/labgate-common.sh"
  install -m 0644 \
    "${REPOSITORY_ROOT}/machine-setup/00-labgate-deny-guest.rules" \
    "${fixture}/source/machine-setup/00-labgate-deny-guest.rules"
  install -m 0644 \
    "${REPOSITORY_ROOT}/machine-setup/sshd-labgate-guest.conf" \
    "${fixture}/source/machine-setup/sshd-labgate-guest.conf"
  install -m 0644 \
    "${REPOSITORY_ROOT}/machine-setup/guest-webhook-flush.path" \
    "${REPOSITORY_ROOT}/machine-setup/guest-webhook-flush.timer" \
    "${fixture}/source/machine-setup/"
  install -m 0755 \
    "${REPOSITORY_ROOT}/machine-setup/setup-machine.sh" \
    "${fixture}/source/machine-setup/setup-machine.sh"
  for command in \
    guest-account.sh guest-cleanup.sh guest-heartbeat.sh guest-session-hook.sh guest-webhook-flush.sh \
    labgate-deny-guest-account-change.sh labgate-provisioner-dispatch.sh; do
    install -m 0700 \
      "${REPOSITORY_ROOT}/machine-setup/${command}" \
      "${fixture}/usr-local-sbin/${command}"
  done

  # One multi-call stub models only the privileged/external effects used by
  # these tests. Filesystem state and the lifecycle scripts themselves remain
  # real. The fixture is deleted after the namespace exits.
  tee "${fixture}/usr-local-sbin/labgate-test-stub" >/dev/null <<'STUB'
#!/usr/bin/env bash
set -u

readonly control=${LABGATE_TEST_CONTROL_DIRECTORY:?}
readonly invoked_as=${0##*/}

case "${invoked_as}" in
  chage)
    [[ "$*" == '--mindays 0 --maxdays -1 --warndays 0 --inactive -1 --expiredate -1 guest' \
      && ! -e ${control}/fail-chage ]] || exit 1
    : >"${control}/aging-safe"
    ;;

  chpasswd)
    /usr/bin/cat >/dev/null
    [[ ! -e ${control}/fail-chpasswd ]]
    ;;

  curl)
    payload=$(/usr/bin/cat)
    printf '%s' "${payload}" >"${control}/last-curl-payload"
    printf '%s\n' "$*" >"${control}/last-curl-arguments"
    : >"${control}/curl-started"
    while [[ -e ${control}/block-curl ]]; do
      /usr/bin/sleep 0.02
    done
    [[ ! -e ${control}/fail-curl ]]
    ;;

  date)
    [[ ! -e ${control}/fail-date ]] || exit 1
    case "${1:-}" in
      +%s)
        if [[ -s ${control}/now ]]; then
          /usr/bin/cat "${control}/now"
        else
          /usr/bin/date +%s
        fi
        ;;
      +%s%N)
        if [[ -s ${control}/now ]]; then
          printf '%s000000000\n' "$(/usr/bin/cat "${control}/now")"
        else
          /usr/bin/date +%s%N
        fi
        ;;
      *) exec /usr/bin/date "$@" ;;
    esac
    ;;

  findmnt)
    [[ -e ${control}/home-mounted ]] || exit 1
    printf 'tmpfs\n'
    ;;

  getent)
    if [[ ${1:-} == passwd && ${2:-} == guest ]]; then
      printf 'guest:x:0:0:LabGate test guest:/home/guest:/bin/bash\n'
      exit 0
    fi
    if [[ ${1:-} == shadow && ${2:-} == guest ]]; then
      if [[ -e ${control}/aging-safe ]]; then
        printf 'guest:!:20000:0::0:::\n'
      else
        printf 'guest:!:20000:1:1:7:1:20001:\n'
      fi
      exit 0
    fi
    exit 2
    ;;

  faillock|pam_tally2|pam_tally)
    [[ "$*" == '--user guest --reset' \
      && ! -e ${control}/fail-auth-counter-reset ]] || exit 1
    /usr/bin/rm -f -- "${control}/auth-failures"
    ;;

  id)
    case "${1:-}" in
      -ru) /usr/bin/cat "${control}/real-uid" 2>/dev/null || printf '0\n' ;;
      -u|-g|-G) printf '0\n' ;;
      *) printf 'uid=0(root) gid=0(root) groups=0(root)\n' ;;
    esac
    ;;

  loginctl)
    case "${1:-}" in
      list-sessions)
        case "$(/usr/bin/cat "${control}/session-status" 2>/dev/null || printf none)" in
          active) printf '1 0 guest seat0 tty1\n' ;;
          none) ;;
          *) exit 1 ;;
        esac
        ;;
      disable-linger)
        printf 'disable-linger\n' >>"${control}/loginctl-order"
        ;;
      terminate-user)
        printf 'terminate-user\n' >>"${control}/loginctl-order"
        ;;
      *) exit 1 ;;
    esac
    ;;

  ipcs)
    [[ ${1:-} =~ ^-[qms]$ && ${2:-} == -c && $# -eq 2 ]] || exit 2
    ipc_flag=${1#-}
    printf '%s\n' '------ LabGate test IPC Creators/Owners --------'
    printf '%s\n' 'id perms cuid cgid uid gid'
    if [[ -f ${control}/sysv-${ipc_flag} ]]; then
      while IFS= read -r ipc_id || [[ -n ${ipc_id} ]]; do
        [[ ${ipc_id} =~ ^[0-9]+$ ]] || exit 1
        printf '%s 600 0 0 0 0\n' "${ipc_id}"
      done <"${control}/sysv-${ipc_flag}"
    fi
    ;;

  ipcrm)
    [[ ${1:-} =~ ^-[qms]$ && ${2:-} =~ ^[0-9]+$ && $# -eq 2 \
      && ! -e ${control}/fail-ipcrm ]] || exit 1
    ipc_flag=${1#-}
    ipc_file=${control}/sysv-${ipc_flag}
    if [[ -f ${ipc_file} ]]; then
      /usr/bin/awk -v target="${2}" '$0 != target { print }' "${ipc_file}" \
        >"${ipc_file}.new" || exit 1
      /usr/bin/mv -f -- "${ipc_file}.new" "${ipc_file}"
    fi
    ;;

  keyctl)
    case "${1:-}" in
      get_persistent)
        [[ ${2:-} == @s && ${3:-} == 0 && $# -eq 3 \
          && ! -e ${control}/fail-keyctl ]] || exit 1
        printf '123\n'
        ;;
      clear)
        [[ ${2:-} == 123 && $# -eq 2 \
          && ! -e ${control}/fail-keyctl ]] || exit 1
        /usr/bin/rm -f -- "${control}/keyring-data"
        ;;
      list)
        [[ ${2:-} == 123 && $# -eq 2 \
          && ! -e ${control}/fail-keyctl ]] || exit 1
        if [[ -e ${control}/keyring-data ]]; then
          printf '1 key in keyring:\n'
          printf ' 1: --alswrv 0 0 user: stale\n'
        else
          printf 'keyring is empty\n'
        fi
        ;;
      unlink)
        [[ ${2:-} == 123 && ${3:-} == @s && $# -eq 3 \
          && ! -e ${control}/fail-keyctl ]] || exit 1
        ;;
      *) exit 2 ;;
    esac
    ;;

  logger)
    exit 0
    ;;

  pgrep)
    [[ -e ${control}/guest-process ]]
    ;;

  pkill)
    [[ ! -e ${control}/fail-pkill ]] || exit 1
    /usr/bin/rm -f -- "${control}/guest-process"
    ;;

  mount)
    : >"${control}/mount-invoked"
    : >"${control}/home-mounted"
    ;;

  mountpoint)
    target=${*: -1}
    case "${target}" in
      /home/guest) [[ -e ${control}/home-mounted ]] ;;
      /run/user/0) [[ -e ${control}/runtime-mounted ]] ;;
      /var/mail/guest|/var/spool/mail/guest) [[ -e ${control}/mailbox-mounted ]] ;;
      *) exit 1 ;;
    esac
    ;;

  passwd)
    case "${1:-}" in
      -S)
        status=$(/usr/bin/cat "${control}/account-status" 2>/dev/null || printf L)
        printf 'guest %s 2026-01-01 0 99999 7 -1\n' "${status}"
        ;;
      -l)
        printf 'L\n' >"${control}/account-status"
        ;;
      -u)
        [[ ! -e ${control}/fail-unlock ]] || exit 1
        printf 'P\n' >"${control}/account-status"
        ;;
      *) exit 2 ;;
    esac
    ;;

  sha256sum)
    /usr/bin/cat >/dev/null < /dev/stdin
    [[ ! -e ${control}/fail-sha256 ]] || exit 1
    # The input has already been consumed, but a deterministic valid digest is
    # sufficient to model a stable PAM transaction context.
    printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  -\n'
    ;;

  ssh-keygen)
    [[ "$*" == '-lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256' \
      && ! -e ${control}/fail-ssh-keygen ]] || exit 1
    if [[ -e ${control}/malformed-ssh-fingerprint ]]; then
      printf '256 SHA256:not-canonical root@test (ED25519)\n'
    elif [[ -e ${control}/wrong-ssh-key-type ]]; then
      printf '256 SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA root@test (ECDSA)\n'
    else
      printf '256 SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA root@test (ED25519)\n'
    fi
    ;;

  sudo)
    printf '%s\n' "$*" >"${control}/last-sudo-arguments"
    /usr/bin/cat >"${control}/last-sudo-stdin"
    ;;

  umount)
    case "${1:-}" in
      /home/guest)
        [[ ! -e ${control}/fail-home-umount ]] || exit 1
        /usr/bin/rm -f -- "${control}/home-mounted"
        ;;
      /run/user/0)
        [[ ! -e ${control}/fail-runtime-umount ]] || exit 1
        /usr/bin/rm -f -- "${control}/runtime-mounted"
        ;;
      /var/mail/guest|/var/spool/mail/guest)
        [[ ! -e ${control}/fail-mailbox-umount ]] || exit 1
        /usr/bin/rm -f -- "${control}/mailbox-mounted"
        ;;
      *) exit 1 ;;
    esac
    ;;

  *)
    printf 'unexpected LabGate test stub invocation: %s\n' "${invoked_as}" >&2
    exit 127
    ;;
esac
STUB
  chmod 0700 "${fixture}/usr-local-sbin/labgate-test-stub"

  for command in \
    chage chpasswd curl date faillock findmnt getent id ipcrm ipcs keyctl loginctl logger mount mountpoint \
    pam_tally pam_tally2 passwd pgrep pkill sha256sum ssh-keygen sudo umount; do
    ln -s labgate-test-stub "${fixture}/usr-local-sbin/${command}"
  done
}

run_outer() {
  local fixture result

  command -v unshare >/dev/null 2>&1 || {
    printf 'machine-setup tests require unshare(1)\n' >&2
    return 1
  }
  fixture=$(mktemp -d "${REPOSITORY_ROOT}/tests/.machine-setup-test.XXXXXX") || return 1
  trap "rm -rf -- $(printf '%q' "${fixture}")" EXIT
  prepare_fixture "${fixture}" || return 1

  unshare -Urnm -- env \
    LABGATE_TEST_CONTROL_DIRECTORY="${fixture}/control" \
    bash "${TEST_SCRIPT}" --inner "${fixture}"
  result=$?
  rm -rf -- "${fixture}"
  trap - EXIT
  return "${result}"
}

mount_fixture() {
  local fixture=$1

  mount --make-rprivate / || return 1
  [[ -d /mnt ]] || return 1
  mount --bind "${fixture}" /mnt || return 1
  mount --bind /mnt/rootfs/etc /etc || return 1
  mount --bind /mnt/rootfs/home /home || return 1
  mount --bind /mnt/rootfs/run /run || return 1
  mount --bind /mnt/rootfs/var-lib /var/lib || return 1
  mount --bind /mnt/scratch/tmp /tmp || return 1
  mount --bind /mnt/scratch/var-tmp /var/tmp || return 1
  mount --bind /mnt/scratch/dev-shm /dev/shm || return 1
  mount --bind /mnt/scratch/mqueue /dev/mqueue || return 1
  mount --bind /mnt/scratch/mail /var/spool/mail || return 1
  mount --bind /mnt/usr-local-lib /usr/local/lib || return 1

  # The hardened dispatcher uses an absolute sudo path. This bind is private
  # to the user/mount namespace and records, rather than executes, its argv.
  mount --bind /mnt/usr-local-sbin/labgate-test-stub /usr/bin/sudo || return 1
  mount --bind /mnt/usr-local-sbin/labgate-test-stub /usr/bin/id || return 1
  mount --bind /mnt/usr-local-sbin /usr/local/sbin || return 1
}

readonly NOW=2000000000
readonly FUTURE=2000000600
readonly CREDENTIAL_A=cred_AAAAAAAAAAAAAAAA
readonly CREDENTIAL_B=cred_BBBBBBBBBBBBBBBB
readonly CREDENTIAL_C=cred_CCCCCCCCCCCCCCCC
readonly PASSWORD=AbcDEf23

fixture=
control=
command_stdout=
command_stderr=
test_count=0
failure_count=0

reset_fixture() {
  /usr/bin/find /var/lib/labgate -mindepth 1 -delete || return 1
  /usr/bin/find /run/labgate -mindepth 1 -delete || return 1
  /usr/bin/find /run/lock -mindepth 1 -delete || return 1
  /usr/bin/find /run/user -mindepth 1 -delete || return 1
  /usr/bin/find /home/guest -mindepth 1 -delete || return 1
  /usr/bin/find /tmp -mindepth 1 -delete || return 1
  /usr/bin/find /var/tmp -mindepth 1 -delete || return 1
  /usr/bin/find /dev/shm -mindepth 1 -delete || return 1
  /usr/bin/find /dev/mqueue -mindepth 1 -delete || return 1
  /usr/bin/find /var/spool/mail -mindepth 1 -delete || return 1
  /usr/bin/find "${control}" -mindepth 1 -delete || return 1
  /usr/bin/rm -rf -- /var/lib/systemd/linger/guest || return 1
  /usr/bin/rm -f -- /etc/labgate/ssh-host-key-sha256 || return 1
  install -d -m 0700 /var/lib/labgate/outbox /var/lib/labgate/tombstones

  printf '8\n' >/etc/labgate/password-length
  printf 'n\n' >/etc/labgate/guest-home-mode
  printf 'faillock\n' >/etc/labgate/auth-failure-backends
  printf 'http://labgate.test\n' >/etc/labgate/api-url
  printf 'header = "Authorization: Bearer test-only-token"\n' >/etc/labgate/webhook-curl.conf
  chmod 0600 \
    /etc/labgate/password-length /etc/labgate/guest-home-mode /etc/labgate/auth-failure-backends \
    /etc/labgate/api-url /etc/labgate/webhook-curl.conf
  printf '%s\n' "${NOW}" >"${control}/now"
  printf 'L\n' >"${control}/account-status"
  printf 'none\n' >"${control}/session-status"
  : >"${control}/auth-failures"
  : >"${command_stdout}"
  : >"${command_stderr}"
}

expect_success() {
  local label=$1
  shift
  if "$@" >"${command_stdout}" 2>"${command_stderr}"; then
    return 0
  fi
  printf '    expected success: %s\n' "${label}" >&2
  sed 's/^/      /' "${command_stderr}" >&2
  return 1
}

expect_failure() {
  local label=$1
  shift
  if "$@" >"${command_stdout}" 2>"${command_stderr}"; then
    printf '    expected failure: %s\n' "${label}" >&2
    return 1
  fi
}

issue_credential() {
  local credential_id=$1 expiry=$2 password=$3

  printf '%s\n' "${password}" \
    | /usr/local/sbin/guest-account.sh issue "${credential_id}" "${expiry}"
}

assert_equal() {
  local actual=$1 expected=$2 label=$3
  if [[ ${actual} == "${expected}" ]]; then
    return 0
  fi
  printf '    %s: expected <%s>, got <%s>\n' "${label}" "${expected}" "${actual}" >&2
  return 1
}

assert_state() {
  local expected_id=$1 expected_expiry=$2 expected_state=$3 expected_version=$4
  local actual_id actual_expiry actual_state actual_version changed_at extra

  [[ -f /var/lib/labgate/credential-state ]] || {
    printf '    credential state file is missing\n' >&2
    return 1
  }
  IFS=$'\t' read -r \
    actual_id actual_expiry actual_state actual_version changed_at extra \
    </var/lib/labgate/credential-state || return 1
  [[ -z ${extra:-} && ${changed_at:-} =~ ^[0-9]+$ ]] || return 1
  assert_equal "${actual_id}" "${expected_id}" 'credential id' || return 1
  assert_equal "${actual_expiry}" "${expected_expiry}" 'credential expiry' || return 1
  assert_equal "${actual_state}" "${expected_state}" 'credential state' || return 1
  assert_equal "${actual_version}" "${expected_version}" 'state version'
}

assert_event() {
  local endpoint=$1 credential_id=$2 version=$3 expected
  expected=$(printf '%s\t%s\t%s' "${endpoint}" "${credential_id}" "${version}")
  grep -R -F -x -- "${expected}" /var/lib/labgate/outbox >/dev/null 2>&1 || {
    printf '    missing outbox event: %s %s v%s\n' "${endpoint}" "${credential_id}" "${version}" >&2
    return 1
  }
}

assert_recovery_reason() {
  local expected_credential_id=$1 expected_reason=$2
  local actual_credential_id actual_reason extra timestamp

  [[ -f /var/lib/labgate/recovery-needed ]] || {
    printf '    recovery-needed file is missing\n' >&2
    return 1
  }
  IFS=$'\t' read -r timestamp actual_credential_id actual_reason extra \
    </var/lib/labgate/recovery-needed || return 1
  [[ -z ${extra:-} && ${timestamp:-} =~ ^[0-9]+$ ]] || return 1
  assert_equal "${actual_credential_id}" "${expected_credential_id}" \
    'recovery credential id' || return 1
  assert_equal "${actual_reason}" "${expected_reason}" 'recovery reason'
}

run_pam() {
  local type=$1
  PAM_USER=guest \
    PAM_TYPE="${type}" \
    PAM_SERVICE=sddm \
    PAM_TTY=tty1 \
    PAM_RHOST= \
    /usr/local/sbin/guest-session-hook.sh
}

write_state_directly() {
  local credential_id=$1 expiry=$2 state=$3
  /usr/bin/bash -c '
    source /usr/local/lib/labgate/labgate-common.sh
    labgate_acquire_lock
    labgate_write_state "$1" "$2" "$3"
  ' _ "${credential_id}" "${expiry}" "${state}"
}

test_issue_validation() {
  reset_fixture || return 1
  printf '4\n' >/etc/labgate/password-length
  expect_failure 'password-length configuration below five' \
    issue_credential "${CREDENTIAL_A}" "${FUTURE}" "${PASSWORD}" || return 1
  [[ ! -e /var/lib/labgate/credential-state ]] || return 1

  printf '5\n' >/etc/labgate/password-length
  expect_success 'minimum five-character password' \
    issue_credential "${CREDENTIAL_A}" "${FUTURE}" AbcDE || return 1
  reset_fixture || return 1

  printf '8\n' >/etc/labgate/password-length
  expect_failure 'missing password stdin' \
    /usr/local/sbin/guest-account.sh issue "${CREDENTIAL_A}" "${FUTURE}" || return 1
  expect_failure 'more than one password input line' bash -c \
    'printf "%s\nextra\n" "$1" | /usr/local/sbin/guest-account.sh issue "$2" "$3"' \
    _ "${PASSWORD}" "${CREDENTIAL_A}" "${FUTURE}" || return 1
  expect_failure 'unterminated extra password input' bash -c \
    'printf "%s\nextra" "$1" | /usr/local/sbin/guest-account.sh issue "$2" "$3"' \
    _ "${PASSWORD}" "${CREDENTIAL_A}" "${FUTURE}" || return 1
  expect_failure 'nine-character password against exact length eight' \
    issue_credential "${CREDENTIAL_A}" "${FUTURE}" AbcDEf234 || return 1
  expect_failure 'password containing a shell metacharacter' \
    issue_credential "${CREDENTIAL_A}" "${FUTURE}" 'AbcDEf2!' || return 1
  expect_failure 'expiry beyond 24 hours plus bounded clock skew' \
    issue_credential "${CREDENTIAL_A}" "$((NOW + 86461))" "${PASSWORD}" || return 1
  [[ ! -e /var/lib/labgate/credential-state ]] || return 1

  expect_success 'valid exact-length issue' \
    issue_credential "${CREDENTIAL_A}" "${FUTURE}" "${PASSWORD}" || return 1
  assert_state "${CREDENTIAL_A}" "${FUTURE}" pending 1 || return 1
  assert_equal "$(<"${control}/account-status")" P 'guest unlock status'
}

test_complete_lifecycle() {
  reset_fixture || return 1
  expect_success 'issue pending generation' \
    issue_credential "${CREDENTIAL_A}" "${FUTURE}" "${PASSWORD}" || return 1
  expect_success 'PAM open' run_pam open_session || return 1
  assert_state "${CREDENTIAL_A}" "${FUTURE}" active 2 || return 1
  [[ -s /run/labgate/pam-session && -e ${control}/home-mounted ]] || return 1
  assert_event session-open "${CREDENTIAL_A}" 2 || return 1

  printf 'active\n' >"${control}/session-status"
  expect_success 'PAM close' run_pam close_session || return 1
  assert_state "${CREDENTIAL_A}" "${FUTURE}" revoked 3 || return 1
  [[ ! -e /run/labgate/pam-session && ! -e ${control}/home-mounted ]] || return 1
  [[ -f /var/lib/labgate/tombstones/${CREDENTIAL_A} ]] || return 1
  assert_equal "$(<"${control}/account-status")" L 'guest lock status' || return 1
  assert_event session-close "${CREDENTIAL_A}" 3
}

test_monotonic_state() {
  reset_fixture || return 1
  expect_success 'issue for monotonic test' \
    issue_credential "${CREDENTIAL_A}" "${FUTURE}" "${PASSWORD}" || return 1
  expect_success 'activate for monotonic test' run_pam open_session || return 1
  expect_failure 'active generation downgrade to pending' \
    write_state_directly "${CREDENTIAL_A}" "${FUTURE}" pending || return 1
  expect_failure 'different generation replacing active state' \
    write_state_directly "${CREDENTIAL_B}" "${FUTURE}" pending || return 1
  assert_state "${CREDENTIAL_A}" "${FUTURE}" active 2 || return 1

  printf 'active\n' >"${control}/session-status"
  expect_success 'close monotonic generation' run_pam close_session || return 1
  expect_failure 'revoked generation downgrade to active' \
    write_state_directly "${CREDENTIAL_A}" "${FUTURE}" active || return 1
  expect_failure 'reissue terminal generation' \
    issue_credential "${CREDENTIAL_A}" "${FUTURE}" "${PASSWORD}" || return 1
  assert_state "${CREDENTIAL_A}" "${FUTURE}" revoked 3
}

test_active_ignores_deadline() {
  reset_fixture || return 1
  expect_success 'issue active-TTL generation' \
    issue_credential "${CREDENTIAL_A}" "${FUTURE}" "${PASSWORD}" || return 1
  expect_success 'activate before deadline' run_pam open_session || return 1
  printf 'active\n' >"${control}/session-status"
  printf '%s\n' "$((FUTURE + 86400 * 30))" >"${control}/now"
  expect_success 'cleanup after active credential deadline' \
    /usr/local/sbin/guest-cleanup.sh || return 1
  assert_state "${CREDENTIAL_A}" "${FUTURE}" active 2 || return 1
  assert_equal "$(<"${control}/account-status")" P 'active guest remains unlocked'
}

test_pending_expiry() {
  reset_fixture || return 1
  expect_success 'issue pending expiry generation' \
    issue_credential "${CREDENTIAL_A}" "${FUTURE}" "${PASSWORD}" || return 1
  printf '%s\n' "${FUTURE}" >"${control}/now"
  expect_success 'expire unused pending generation' /usr/local/sbin/guest-cleanup.sh || return 1
  assert_state "${CREDENTIAL_A}" "${FUTURE}" revoked 3 || return 1
  assert_equal "$(<"${control}/account-status")" L 'expired guest is locked' || return 1
  assert_event credential-expired "${CREDENTIAL_A}" 3
}

test_pending_clock_failures() {
  reset_fixture || return 1
  expect_success 'issue PAM rollback generation' \
    issue_credential "${CREDENTIAL_A}" "${FUTURE}" "${PASSWORD}" || return 1
  printf '%s\n' "$((NOW - 1))" >"${control}/now"
  expect_failure 'PAM open after wall-clock rollback' run_pam open_session || return 1
  assert_state "${CREDENTIAL_A}" "${FUTURE}" pending 1 || return 1
  assert_equal "$(<"${control}/account-status")" L \
    'PAM rollback locks pending guest' || return 1
  [[ ! -e ${control}/home-mounted && ! -e /run/labgate/pam-session ]] || return 1
  assert_recovery_reason "${CREDENTIAL_A}" pam-open-clock-rollback || return 1

  reset_fixture || return 1
  expect_success 'issue pending date-failure generation' \
    issue_credential "${CREDENTIAL_A}" "${FUTURE}" "${PASSWORD}" || return 1
  : >"${control}/fail-date"
  expect_failure 'pending cleanup when clock read fails' \
    /usr/local/sbin/guest-cleanup.sh || return 1
  assert_state "${CREDENTIAL_A}" "${FUTURE}" pending 1 || return 1
  assert_equal "$(<"${control}/account-status")" L \
    'pending date failure locks guest' || return 1
  assert_recovery_reason "${CREDENTIAL_A}" pending-clock-unavailable || return 1

  reset_fixture || return 1
  expect_success 'issue pending rollback generation' \
    issue_credential "${CREDENTIAL_B}" "${FUTURE}" "${PASSWORD}" || return 1
  printf '%s\n' "$((NOW - 1))" >"${control}/now"
  expect_failure 'pending cleanup after wall-clock rollback' \
    /usr/local/sbin/guest-cleanup.sh || return 1
  assert_state "${CREDENTIAL_B}" "${FUTURE}" pending 1 || return 1
  assert_equal "$(<"${control}/account-status")" L \
    'pending rollback locks guest' || return 1
  assert_recovery_reason "${CREDENTIAL_B}" pending-clock-rollback
}

test_active_clock_failures() {
  reset_fixture || return 1
  expect_success 'issue active rollback generation' \
    issue_credential "${CREDENTIAL_A}" "${FUTURE}" "${PASSWORD}" || return 1
  expect_success 'open active rollback generation' run_pam open_session || return 1
  printf 'active\n' >"${control}/session-status"
  printf '%s\n' "$((NOW - 1))" >"${control}/now"
  expect_success 'active logind session survives wall-clock rollback' \
    /usr/local/sbin/guest-cleanup.sh || return 1
  assert_state "${CREDENTIAL_A}" "${FUTURE}" active 2 || return 1
  assert_equal "$(<"${control}/account-status")" P \
    'active session remains unlocked on rollback' || return 1
  [[ -e ${control}/home-mounted && -e /run/labgate/pam-session ]] || return 1
  [[ ! -e /var/lib/labgate/recovery-needed ]] || return 1
  : >"${control}/fail-date"
  expect_success 'active logind session survives clock read failure' \
    /usr/local/sbin/guest-cleanup.sh || return 1
  assert_state "${CREDENTIAL_A}" "${FUTURE}" active 2 || return 1
  assert_equal "$(<"${control}/account-status")" P \
    'active session remains unlocked without wall clock' || return 1

  reset_fixture || return 1
  expect_success 'issue sessionless date-failure generation' \
    issue_credential "${CREDENTIAL_B}" "${FUTURE}" "${PASSWORD}" || return 1
  expect_success 'open sessionless date-failure generation' run_pam open_session || return 1
  : >"${control}/fail-date"
  expect_failure 'sessionless active cleanup when clock read fails' \
    /usr/local/sbin/guest-cleanup.sh || return 1
  assert_state "${CREDENTIAL_B}" "${FUTURE}" active 2 || return 1
  assert_equal "$(<"${control}/account-status")" L \
    'sessionless date failure locks guest' || return 1
  [[ ! -e ${control}/home-mounted && ! -e /run/labgate/pam-session ]] || return 1
  assert_recovery_reason "${CREDENTIAL_B}" stale-active-clock-unavailable || return 1

  reset_fixture || return 1
  expect_success 'issue sessionless rollback generation' \
    issue_credential "${CREDENTIAL_C}" "${FUTURE}" "${PASSWORD}" || return 1
  expect_success 'open sessionless rollback generation' run_pam open_session || return 1
  printf '%s\n' "$((NOW - 1))" >"${control}/now"
  expect_failure 'sessionless active cleanup after wall-clock rollback' \
    /usr/local/sbin/guest-cleanup.sh || return 1
  assert_state "${CREDENTIAL_C}" "${FUTURE}" active 2 || return 1
  assert_equal "$(<"${control}/account-status")" L \
    'sessionless rollback locks guest' || return 1
  [[ ! -e ${control}/home-mounted && ! -e /run/labgate/pam-session ]] || return 1
  assert_recovery_reason "${CREDENTIAL_C}" stale-active-clock-rollback
}

test_revoke_guards() {
  reset_fixture || return 1
  expect_success 'issue exact revoke generation' \
    issue_credential "${CREDENTIAL_A}" "${FUTURE}" "${PASSWORD}" || return 1
  expect_failure 'mismatched revoke while pending' \
    /usr/local/sbin/guest-account.sh revoke "${CREDENTIAL_B}" || return 1
  assert_state "${CREDENTIAL_A}" "${FUTURE}" pending 1 || return 1
  expect_success 'exact pending revoke' \
    /usr/local/sbin/guest-account.sh revoke "${CREDENTIAL_A}" || return 1
  assert_state "${CREDENTIAL_A}" "${FUTURE}" revoked 3 || return 1

  expect_success 'issue active revoke generation' \
    issue_credential "${CREDENTIAL_B}" "${FUTURE}" "${PASSWORD}" || return 1
  expect_success 'activate revoke guard generation' run_pam open_session || return 1
  expect_failure 'exact revoke while active' \
    /usr/local/sbin/guest-account.sh revoke "${CREDENTIAL_B}" || return 1
  assert_state "${CREDENTIAL_B}" "${FUTURE}" active 2
}

test_compensation_tombstone() {
  reset_fixture || return 1
  expect_success 'no-state compensation revoke' \
    /usr/local/sbin/guest-account.sh revoke "${CREDENTIAL_A}" || return 1
  [[ -f /var/lib/labgate/tombstones/${CREDENTIAL_A} ]] || return 1
  expect_failure 'delayed issue after compensation revoke' \
    issue_credential "${CREDENTIAL_A}" "${FUTURE}" "${PASSWORD}" || return 1
  assert_state "${CREDENTIAL_A}" "${NOW}" revoked 3
}

test_tombstone_history() {
  reset_fixture || return 1
  expect_success 'terminal generation A without prior state' \
    /usr/local/sbin/guest-account.sh revoke "${CREDENTIAL_A}" || return 1
  expect_success 'issue generation B' \
    issue_credential "${CREDENTIAL_B}" "${FUTURE}" "${PASSWORD}" || return 1
  expect_success 'revoke generation B' \
    /usr/local/sbin/guest-account.sh revoke "${CREDENTIAL_B}" || return 1
  expect_success 'issue generation C' \
    issue_credential "${CREDENTIAL_C}" "${FUTURE}" "${PASSWORD}" || return 1
  expect_success 'revoke generation C' \
    /usr/local/sbin/guest-account.sh revoke "${CREDENTIAL_C}" || return 1

  [[ -f /var/lib/labgate/tombstones/${CREDENTIAL_A} ]] || return 1
  [[ -f /var/lib/labgate/tombstones/${CREDENTIAL_B} ]] || return 1
  [[ -f /var/lib/labgate/tombstones/${CREDENTIAL_C} ]] || return 1
  expect_failure 'old delayed generation cannot overwrite newer terminal state' \
    issue_credential "${CREDENTIAL_A}" "${FUTURE}" "${PASSWORD}" || return 1
  assert_state "${CREDENTIAL_C}" "${FUTURE}" revoked 3
}

test_dispatcher() {
  local command

  reset_fixture || return 1
  command="sudo /usr/local/sbin/guest-account.sh issue ${CREDENTIAL_A} ${FUTURE}"
  expect_success 'dispatcher issue command' bash -c \
    'printf "%s\n" "$1" | env SSH_ORIGINAL_COMMAND="$2" /usr/local/sbin/labgate-provisioner-dispatch.sh' \
    _ "${PASSWORD}" "${command}" || return 1
  assert_equal "$(<"${control}/last-sudo-arguments")" \
    "-- /usr/local/sbin/guest-account.sh issue ${CREDENTIAL_A} ${FUTURE}" \
    'dispatcher issue argv' || return 1
  assert_equal "$(<"${control}/last-sudo-stdin")" "${PASSWORD}" \
    'dispatcher issue stdin' || return 1
  [[ $(<"${control}/last-sudo-arguments") != *"${PASSWORD}"* ]] || return 1

  expect_failure 'dispatcher issue without password input' env \
    SSH_ORIGINAL_COMMAND="${command}" /usr/local/sbin/labgate-provisioner-dispatch.sh \
    || return 1
  expect_failure 'dispatcher issue with extra input line' bash -c \
    'printf "%s\nextra\n" "$1" | env SSH_ORIGINAL_COMMAND="$2" /usr/local/sbin/labgate-provisioner-dispatch.sh' \
    _ "${PASSWORD}" "${command}" || return 1
  expect_failure 'dispatcher issue with unterminated extra input' bash -c \
    'printf "%s\nextra" "$1" | env SSH_ORIGINAL_COMMAND="$2" /usr/local/sbin/labgate-provisioner-dispatch.sh' \
    _ "${PASSWORD}" "${command}" || return 1
  expect_failure 'dispatcher rejects legacy password argument' env \
    SSH_ORIGINAL_COMMAND="${command} ${PASSWORD}" \
    /usr/local/sbin/labgate-provisioner-dispatch.sh || return 1

  command="sudo /usr/local/sbin/guest-account.sh revoke ${CREDENTIAL_A}"
  expect_success 'dispatcher revoke command' env SSH_ORIGINAL_COMMAND="${command}" \
    /usr/local/sbin/labgate-provisioner-dispatch.sh || return 1
  assert_equal "$(<"${control}/last-sudo-arguments")" \
    "-- /usr/local/sbin/guest-account.sh revoke ${CREDENTIAL_A}" \
    'dispatcher revoke argv' || return 1

  expect_failure 'dispatcher missing command' env -u SSH_ORIGINAL_COMMAND \
    /usr/local/sbin/labgate-provisioner-dispatch.sh || return 1
  expect_failure 'dispatcher repeated whitespace' env \
    SSH_ORIGINAL_COMMAND="sudo  /usr/local/sbin/guest-account.sh revoke ${CREDENTIAL_A}" \
    /usr/local/sbin/labgate-provisioner-dispatch.sh || return 1
  expect_failure 'dispatcher extra argument' env \
    SSH_ORIGINAL_COMMAND="sudo /usr/local/sbin/guest-account.sh revoke ${CREDENTIAL_A} extra" \
    /usr/local/sbin/labgate-provisioner-dispatch.sh || return 1
  expect_failure 'dispatcher shell syntax' env \
    SSH_ORIGINAL_COMMAND="sudo /usr/local/sbin/guest-account.sh revoke ${CREDENTIAL_A};id" \
    /usr/local/sbin/labgate-provisioner-dispatch.sh || return 1
  expect_failure 'dispatcher tab' env \
    SSH_ORIGINAL_COMMAND=$'sudo\t/usr/local/sbin/guest-account.sh revoke cred_AAAAAAAAAAAAAAAA' \
    /usr/local/sbin/labgate-provisioner-dispatch.sh || return 1
  expect_failure 'dispatcher newline' env \
    SSH_ORIGINAL_COMMAND=$'sudo /usr/local/sbin/guest-account.sh revoke cred_AAAAAAAAAAAAAAAA\nid' \
    /usr/local/sbin/labgate-provisioner-dispatch.sh
}

test_heartbeat_json() {
  local expected

  reset_fixture || return 1
  expect_success 'issue heartbeat generation' \
    issue_credential "${CREDENTIAL_A}" "${FUTURE}" "${PASSWORD}" || return 1
  expect_success 'activate heartbeat generation' run_pam open_session || return 1
  printf 'active\n' >"${control}/session-status"
  expect_success 'emit heartbeat' /usr/local/sbin/guest-heartbeat.sh || return 1
  expected=$(printf \
    '{"credentialId":"%s","stateVersion":2,"sessionActive":true,"guestLocked":false,"state":"active"}' \
    "${CREDENTIAL_A}")
  assert_equal "$(<"${control}/last-curl-payload")" "${expected}" 'heartbeat JSON'
}

test_heartbeat_no_state_safety() {
  local expected

  reset_fixture || return 1
  printf 'P\n' >"${control}/account-status"
  printf 'orphan\n' >"${control}/guest-process"
  : >"${control}/home-mounted"
  : >/var/lib/systemd/linger/guest
  printf 'orphan-marker\n' >/run/labgate/pam-session
  expect_success 'no-state heartbeat secures before reporting' \
    /usr/local/sbin/guest-heartbeat.sh || return 1
  expected='{"credentialId":null,"stateVersion":null,"sessionActive":false,"guestLocked":true,"state":null}'
  assert_equal "$(<"${control}/last-curl-payload")" "${expected}" \
    'secured no-state heartbeat JSON' || return 1
  assert_equal "$(<"${control}/account-status")" L \
    'no-state heartbeat locks guest' || return 1
  [[ ! -e ${control}/guest-process \
    && ! -e ${control}/home-mounted \
    && ! -e /var/lib/systemd/linger/guest \
    && ! -e /run/labgate/pam-session ]] || return 1

  reset_fixture || return 1
  printf 'P\n' >"${control}/account-status"
  printf 'orphan\n' >"${control}/guest-process"
  : >"${control}/home-mounted"
  mkdir /var/lib/systemd/linger/guest || return 1
  expect_success 'unsafe no-state heartbeat is withheld' \
    /usr/local/sbin/guest-heartbeat.sh || return 1
  [[ ! -e ${control}/last-curl-payload ]] || return 1
  assert_equal "$(<"${control}/account-status")" L \
    'failed no-state proof still locks guest' || return 1
  [[ ! -e ${control}/guest-process && ! -e ${control}/home-mounted \
    && -d /var/lib/systemd/linger/guest ]] || return 1
  assert_recovery_reason - heartbeat-no-state-safety-failed || return 1

  reset_fixture || return 1
  printf 'corrupt state\n' >/var/lib/labgate/credential-state
  chmod 0600 /var/lib/labgate/credential-state
  printf 'P\n' >"${control}/account-status"
  printf 'orphan\n' >"${control}/guest-process"
  : >"${control}/home-mounted"
  : >/var/lib/systemd/linger/guest
  expect_success 'corrupt state secures without a no-state report' \
    /usr/local/sbin/guest-heartbeat.sh || return 1
  [[ ! -e ${control}/last-curl-payload \
    && -f /var/lib/labgate/credential-state \
    && ! -e ${control}/guest-process \
    && ! -e ${control}/home-mounted \
    && ! -e /var/lib/systemd/linger/guest ]] || return 1
  assert_equal "$(<"${control}/account-status")" L \
    'corrupt-state heartbeat locks guest' || return 1
  assert_recovery_reason - heartbeat-corrupt-state
}

test_pam_close_fail_secure() {
  reset_fixture || return 1
  expect_success 'issue missing-marker generation' \
    issue_credential "${CREDENTIAL_A}" "${FUTURE}" "${PASSWORD}" || return 1
  expect_success 'open missing-marker generation' run_pam open_session || return 1
  /usr/bin/rm -f -- /run/labgate/pam-session
  expect_success 'close with missing owner marker' run_pam close_session || return 1
  assert_state "${CREDENTIAL_A}" "${FUTURE}" revoked 3 || return 1
  assert_equal "$(<"${control}/account-status")" L 'missing-marker close locks guest' || return 1

  reset_fixture || return 1
  expect_success 'issue context-failure generation' \
    issue_credential "${CREDENTIAL_B}" "${FUTURE}" "${PASSWORD}" || return 1
  expect_success 'open context-failure generation' run_pam open_session || return 1
  : >"${control}/fail-sha256"
  expect_success 'close with context hashing failure' run_pam close_session || return 1
  assert_state "${CREDENTIAL_B}" "${FUTURE}" revoked 3 || return 1
  assert_equal "$(<"${control}/account-status")" L 'context-failure close locks guest'
}

test_pam_open_fail_secure() {
  reset_fixture || return 1
  printf 'P\n' >"${control}/account-status"
  : >"${control}/home-mounted"
  expect_failure 'open with missing lifecycle state' run_pam open_session || return 1
  assert_equal "$(<"${control}/account-status")" L \
    'missing-state open locks guest' || return 1
  [[ ! -e ${control}/home-mounted && -s /var/lib/labgate/recovery-needed ]] || return 1

  reset_fixture || return 1
  printf 'corrupt state\n' >/var/lib/labgate/credential-state
  chmod 0600 /var/lib/labgate/credential-state
  printf 'P\n' >"${control}/account-status"
  : >"${control}/home-mounted"
  expect_failure 'open with corrupt lifecycle state' run_pam open_session || return 1
  assert_equal "$(<"${control}/account-status")" L \
    'corrupt-state open locks guest' || return 1
  [[ ! -e ${control}/home-mounted && -s /var/lib/labgate/recovery-needed ]] || return 1

  reset_fixture || return 1
  expect_success 'issue clock-failure generation' \
    issue_credential "${CREDENTIAL_A}" "${FUTURE}" "${PASSWORD}" || return 1
  : >"${control}/fail-date"
  expect_failure 'open when clock read fails' run_pam open_session || return 1
  assert_equal "$(<"${control}/account-status")" L \
    'clock-failure open locks guest' || return 1

  reset_fixture || return 1
  expect_success 'issue lock-status generation' \
    issue_credential "${CREDENTIAL_B}" "${FUTURE}" "${PASSWORD}" || return 1
  printf 'unknown\n' >"${control}/account-status"
  expect_failure 'open with unknown account lock status' run_pam open_session || return 1
  assert_equal "$(<"${control}/account-status")" L \
    'unknown-lock-status open locks guest'
}

test_guest_account_change_policy() {
  reset_fixture || return 1
  printf '1000\n' >"${control}/real-uid"
  expect_failure 'guest cannot persistently change its account' env PAM_USER=guest \
    /usr/local/sbin/labgate-deny-guest-account-change.sh || return 1
  expect_success 'unrelated non-root account is unaffected' env PAM_USER=student \
    /usr/local/sbin/labgate-deny-guest-account-change.sh || return 1
  printf '0\n' >"${control}/real-uid"
  expect_success 'root can maintain the guest account' env PAM_USER=guest \
    /usr/local/sbin/labgate-deny-guest-account-change.sh
}

test_guest_linger_safety() {
  local disable_line terminate_line

  reset_fixture || return 1
  : >/var/lib/systemd/linger/guest
  : >"${control}/home-mounted"
  printf 'P\n' >"${control}/account-status"
  expect_success 'secure path disables and removes guest linger' bash -c '
    source /usr/local/lib/labgate/labgate-common.sh
    labgate_secure_guest
  ' || return 1
  [[ ! -e /var/lib/systemd/linger/guest \
    && ! -L /var/lib/systemd/linger/guest ]] || return 1
  assert_equal "$(<"${control}/account-status")" L \
    'linger cleanup also locks guest' || return 1
  [[ ! -e ${control}/home-mounted ]] || return 1
  disable_line=$(grep -n -m1 '^disable-linger$' "${control}/loginctl-order" | cut -d: -f1) \
    || return 1
  terminate_line=$(grep -n -m1 '^terminate-user$' "${control}/loginctl-order" | cut -d: -f1) \
    || return 1
  (( disable_line < terminate_line )) || return 1

  reset_fixture || return 1
  mkdir /var/lib/systemd/linger/guest || return 1
  : >"${control}/home-mounted"
  printf 'P\n' >"${control}/account-status"
  expect_failure 'persistent guest linger path is a safety failure' bash -c '
    source /usr/local/lib/labgate/labgate-common.sh
    labgate_secure_guest
  ' || return 1
  [[ -d /var/lib/systemd/linger/guest ]] || return 1
  assert_equal "$(<"${control}/account-status")" L \
    'linger failure still locks guest' || return 1
  [[ ! -e ${control}/home-mounted ]] || return 1
  grep -Fqx disable-linger "${control}/loginctl-order" || return 1
  grep -Fqx terminate-user "${control}/loginctl-order"
}

test_guest_external_state_boundary() {
  local runtime_metadata

  reset_fixture || return 1
  install -d -m 0700 /run/user/0
  printf 'stale runtime\n' >/run/user/0/secret
  : >"${control}/runtime-mounted"
  printf 'stale queue\n' >/dev/mqueue/labgate-stale
  printf '101\n102\n' >"${control}/sysv-q"
  printf '201\n' >"${control}/sysv-m"
  printf '301\n' >"${control}/sysv-s"
  : >"${control}/keyring-data"
  printf 'stale mail\n' >/var/spool/mail/guest
  printf 'P\n' >"${control}/account-status"
  : >"${control}/home-mounted"
  expect_success 'secure path clears bounded guest persistence surfaces' bash -c '
    source /usr/local/lib/labgate/labgate-common.sh
    labgate_secure_guest
  ' || return 1
  [[ ! -e /run/user/0 && ! -L /run/user/0 \
    && ! -e "${control}/runtime-mounted" \
    && ! -e /dev/mqueue/labgate-stale \
    && ! -s "${control}/sysv-q" \
    && ! -s "${control}/sysv-m" \
    && ! -s "${control}/sysv-s" \
    && ! -e "${control}/keyring-data" \
    && ! -e /var/spool/mail/guest \
    && ! -e "${control}/home-mounted" ]] || return 1

  reset_fixture || return 1
  install -d -m 0700 /run/user/0
  printf 'prior runtime\n' >/run/user/0/prior-secret
  expect_success 'issue for fresh runtime test' \
    issue_credential "${CREDENTIAL_A}" "${FUTURE}" "${PASSWORD}" || return 1
  expect_success 'PAM open creates fresh runtime boundary' run_pam open_session || return 1
  [[ -d /run/user/0 && ! -L /run/user/0 \
    && ! -e /run/user/0/prior-secret ]] || return 1
  runtime_metadata=$(stat -c '%u:%g:%a' -- /run/user/0) || return 1
  assert_equal "${runtime_metadata}" 0:0:700 'fresh guest runtime metadata' || return 1

  reset_fixture || return 1
  install -d -m 0700 /run/user/0
  printf 'unsafe mounted runtime\n' >/run/user/0/secret
  : >"${control}/runtime-mounted"
  : >"${control}/fail-runtime-umount"
  printf 'stale queue\n' >/dev/mqueue/labgate-stale
  expect_failure 'runtime unmount ambiguity fails the safety proof' bash -c '
    source /usr/local/lib/labgate/labgate-common.sh
    labgate_secure_guest
  ' || return 1
  [[ -e "${control}/runtime-mounted" \
    && -e /run/user/0/secret \
    && ! -e /dev/mqueue/labgate-stale ]] || return 1
}

test_persistent_guest_home_mode() {
  reset_fixture || return 1
  printf 'y\n' >/etc/labgate/guest-home-mode
  chmod 0600 /etc/labgate/guest-home-mode
  printf 'persistent data\n' >/home/guest/keep.txt
  expect_success 'persistent home opens without tmpfs' \
    issue_credential "${CREDENTIAL_A}" "${FUTURE}" "${PASSWORD}" || return 1
  expect_success 'persistent home PAM open' run_pam open_session || return 1
  [[ -f /home/guest/keep.txt && ! -e ${control}/mount-invoked ]] || return 1
  expect_success 'persistent home PAM close' run_pam close_session || return 1
  [[ -f /home/guest/keep.txt && ! -e ${control}/home-mounted ]] || return 1
}

test_guest_home_mode_validation_and_drain_gate() {
  reset_fixture || return 1
  expect_success 'drained mode-change precondition' bash -c '
    source /usr/local/lib/labgate/labgate-common.sh
    labgate_guest_home_mode_change_is_drained
  ' || return 1
  printf 'x\n' >/etc/labgate/guest-home-mode
  chmod 0600 /etc/labgate/guest-home-mode
  expect_failure 'invalid persisted home mode is rejected' bash -c '
    source /usr/local/lib/labgate/labgate-common.sh
    labgate_load_guest_home_mode
  ' || return 1
  printf 'y\n' >/etc/labgate/guest-home-mode
  printf 'active\n' >"${control}/session-status"
  expect_failure 'active session blocks mode changes' bash -c '
    source /usr/local/lib/labgate/labgate-common.sh
    labgate_guest_home_mode_change_is_drained
  '
}

test_guest_authentication_reset() {
  reset_fixture || return 1
  [[ -e "${control}/auth-failures" && ! -e "${control}/aging-safe" ]] || return 1
  expect_success 'issue resets aging and faillock state' \
    issue_credential "${CREDENTIAL_A}" "${FUTURE}" "${PASSWORD}" || return 1
  [[ -e "${control}/aging-safe" && ! -e "${control}/auth-failures" ]] || return 1
  assert_equal "$(<"${control}/account-status")" P \
    'successful authentication reset permits unlock' || return 1

  reset_fixture || return 1
  : >"${control}/fail-auth-counter-reset"
  expect_failure 'counter reset failure keeps issued generation locked' \
    issue_credential "${CREDENTIAL_B}" "${FUTURE}" "${PASSWORD}" || return 1
  assert_state "${CREDENTIAL_B}" "${FUTURE}" pending 1 || return 1
  assert_equal "$(<"${control}/account-status")" L \
    'counter reset failure leaves guest locked' || return 1
  assert_recovery_reason "${CREDENTIAL_B}" issue-authentication-reset-failed || return 1

  reset_fixture || return 1
  : >"${control}/fail-chage"
  expect_failure 'aging reset failure keeps issued generation locked' \
    issue_credential "${CREDENTIAL_C}" "${FUTURE}" "${PASSWORD}" || return 1
  assert_equal "$(<"${control}/account-status")" L \
    'aging reset failure leaves guest locked' || return 1
  assert_recovery_reason "${CREDENTIAL_C}" issue-authentication-reset-failed
}

test_private_directory_initialization() {
  reset_fixture || return 1
  /usr/bin/rm -rf -- /var/lib/labgate || return 1
  install -d -m 0700 "${control}/state-escape"
  printf 'preserve\n' >"${control}/state-escape/sentinel"
  ln -s "${control}/state-escape" /var/lib/labgate || return 1
  expect_failure 'state directory symlink is rejected before mutation' bash -c '
    source /usr/local/lib/labgate/labgate-common.sh
    labgate_initialize_directories
  ' || return 1
  assert_equal "$(<"${control}/state-escape/sentinel")" preserve \
    'symlink target remains untouched' || return 1
  [[ -L /var/lib/labgate ]] || return 1

  /usr/bin/rm -f -- /var/lib/labgate || return 1
  install -d -m 0700 /var/lib/labgate/outbox /var/lib/labgate/tombstones
  expect_success 'private directories are created with canonical metadata' bash -c '
    source /usr/local/lib/labgate/labgate-common.sh
    labgate_initialize_directories
  ' || return 1
  [[ $(stat -c '%u:%g:%a' -- /var/lib/labgate) == 0:0:700 \
    && $(stat -c '%u:%g:%a' -- /var/lib/labgate/outbox) == 0:0:700 \
    && $(stat -c '%u:%g:%a' -- /run/labgate) == 0:0:700 \
    && $(stat -c '%u:%g:%a' -- /run/lock/labgate) == 0:0:700 ]]
}

test_ssh_host_key_fingerprint_boundary() {
  local fingerprint

  reset_fixture || return 1
  fingerprint=$(bash -c '
    source /usr/local/lib/labgate/labgate-common.sh
    labgate_compute_ssh_host_key_sha256
  ') || return 1
  assert_equal "${fingerprint}" \
    SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA \
    'canonical local Ed25519 fingerprint' || return 1

  printf '%s\n' "${fingerprint}" >/etc/labgate/ssh-host-key-sha256
  chmod 0600 /etc/labgate/ssh-host-key-sha256
  expect_success 'root-private persisted SSH host-key pin is accepted' bash -c '
    source /usr/local/lib/labgate/labgate-common.sh
    test "$(labgate_read_persisted_ssh_host_key_sha256)" = \
      SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
  ' || return 1

  : >"${control}/malformed-ssh-fingerprint"
  expect_failure 'malformed ssh-keygen fingerprint is rejected' bash -c '
    source /usr/local/lib/labgate/labgate-common.sh
    labgate_compute_ssh_host_key_sha256
  ' || return 1
  /usr/bin/rm -f -- "${control}/malformed-ssh-fingerprint"
  : >"${control}/wrong-ssh-key-type"
  expect_failure 'non-Ed25519 ssh-keygen result is rejected' bash -c '
    source /usr/local/lib/labgate/labgate-common.sh
    labgate_compute_ssh_host_key_sha256
  '
}

test_setup_configuration_boundaries() {
  local account_line origin secret_line
  local -a invalid_origins valid_origins

  reset_fixture || return 1
  valid_origins=(
    http://100.64.0.1:3000
    https://raspberrypi.tailfdedcf.ts.net
    https://labgate-1
    http://localhost:65535
  )
  invalid_origins=(
    http://user@100.64.0.1:3000
    http://100.64.0.1:3000/
    'http://100.64.0.1:3000?x=1'
    'http://100.64.0.1:3000#fragment'
    http://010.64.0.1:3000
    http://100.64.0.256:3000
    http://100.64.0.1:0
    http://100.64.0.1:65536
    http://100.64.0.1:03000
    https://RaspberryPi.tailfdedcf.ts.net
    https://raspberrypi.tailfdedcf.ts.net.
    https://bad..tailfdedcf.ts.net
    https://-bad.tailfdedcf.ts.net
    ftp://100.64.0.1
  )
  for origin in "${valid_origins[@]}"; do
    expect_success "valid API origin ${origin}" bash -c '
      source /usr/local/lib/labgate/labgate-common.sh
      labgate_validate_api_origin "$1"
    ' _ "${origin}" || return 1
  done
  for origin in "${invalid_origins[@]}"; do
    expect_failure "invalid API origin ${origin}" bash -c '
      source /usr/local/lib/labgate/labgate-common.sh
      labgate_validate_api_origin "$1"
    ' _ "${origin}" || return 1
  done

  expect_success 'standard Base64 registration bearer syntax' bash -c '
    source /usr/local/lib/labgate/labgate-common.sh
    labgate_validate_registration_secret "abcdefghijklmnopqr+/=="
  ' || return 1
  for invalid_secret in short 'abcdefghijklmnopqrs =' 'abcdefghijklmnopqrs=bad'; do
    expect_failure 'invalid first-registration bearer syntax' bash -c '
      source /usr/local/lib/labgate/labgate-common.sh
      labgate_validate_registration_secret "$1"
    ' _ "${invalid_secret}" || return 1
  done

  secret_line=$(grep -n -m1 \
    'before first-registration setup can change account, PAM, or SSH policy' \
    /mnt/source/machine-setup/setup-machine.sh | cut -d: -f1) || return 1
  account_line=$(grep -n -m1 '^getent passwd provisioner' \
    /mnt/source/machine-setup/setup-machine.sh | cut -d: -f1) || return 1
  (( secret_line < account_line )) || return 1
}

test_outbox_monotonic_sequence() {
  local before_count
  local -a events

  reset_fixture || return 1
  expect_success 'queue first versioned event' bash -c '
    source /usr/local/lib/labgate/labgate-common.sh
    labgate_queue_event session-open "$1" 2
  ' _ "${CREDENTIAL_A}" || return 1
  : >"${control}/fail-date"
  expect_success 'queue remains independent from wall-clock failure' bash -c '
    source /usr/local/lib/labgate/labgate-common.sh
    labgate_queue_event session-close "$1" 3
  ' _ "${CREDENTIAL_A}" || return 1
  /usr/bin/rm -f -- "${control}/fail-date"

  mapfile -t events < <(
    /usr/bin/find /var/lib/labgate/outbox -maxdepth 1 -type f -name 'event-*' \
      -printf '%f\n' | /usr/bin/sort
  )
  (( ${#events[@]} == 2 )) || return 1
  assert_equal "${events[0]}" event-v2-000000000000000001 \
    'first persistent outbox sequence' || return 1
  assert_equal "${events[1]}" event-v2-000000000000000002 \
    'second persistent outbox sequence' || return 1
  assert_equal "$(</var/lib/labgate/outbox-sequence)" 2 \
    'persisted sequence after two events' || return 1

  # A stale but syntactically valid counter is recovered from live filenames;
  # this models restoration of an older counter snapshot without reusing a name.
  printf '0\n' >/var/lib/labgate/outbox-sequence
  chmod 0600 /var/lib/labgate/outbox-sequence
  expect_success 'recover stale sequence from live queue' bash -c '
    source /usr/local/lib/labgate/labgate-common.sh
    labgate_queue_event session-close "$1" 3
  ' _ "${CREDENTIAL_B}" || return 1
  [[ -f /var/lib/labgate/outbox/event-v2-000000000000000003 ]] || return 1

  # A sequence advanced before an interrupted publish leaves a gap, not reuse.
  printf '5\n' >/var/lib/labgate/outbox-sequence
  expect_success 'preserve crash-allocation gap' bash -c '
    source /usr/local/lib/labgate/labgate-common.sh
    labgate_queue_event credential-expired "$1" 3
  ' _ "${CREDENTIAL_C}" || return 1
  [[ -f /var/lib/labgate/outbox/event-v2-000000000000000006 ]] || return 1
  assert_equal "$(</var/lib/labgate/outbox-sequence)" 6 \
    'sequence after crash gap' || return 1

  before_count=$(/usr/bin/find /var/lib/labgate/outbox -maxdepth 1 -type f \
    -name 'event-*' | /usr/bin/wc -l)
  printf '01\n' >/var/lib/labgate/outbox-sequence
  expect_failure 'corrupt sequence fails closed' bash -c '
    source /usr/local/lib/labgate/labgate-common.sh
    labgate_queue_event session-close "$1" 3
  ' _ "${CREDENTIAL_A}" || return 1
  assert_equal \
    "$(/usr/bin/find /var/lib/labgate/outbox -maxdepth 1 -type f -name 'event-*' | /usr/bin/wc -l)" \
    "${before_count}" 'corrupt sequence publishes no event'
}

test_outbox_producer_does_not_wait_for_network() {
  local attempt flush_pid

  reset_fixture || return 1
  expect_success 'queue event for blocked worker' bash -c '
    source /usr/local/lib/labgate/labgate-common.sh
    labgate_queue_event session-open "$1" 2
  ' _ "${CREDENTIAL_A}" || return 1
  : >"${control}/block-curl"
  /usr/local/sbin/guest-webhook-flush.sh &
  flush_pid=$!
  for attempt in {1..100}; do
    [[ -e ${control}/curl-started ]] && break
    /usr/bin/sleep 0.02
  done
  if [[ ! -e ${control}/curl-started ]]; then
    /usr/bin/rm -f -- "${control}/block-curl"
    kill "${flush_pid}" >/dev/null 2>&1 || true
    wait "${flush_pid}" 2>/dev/null || true
    return 1
  fi

  if ! expect_success 'producer bypasses worker network lock' \
    timeout --signal=KILL 1 bash -c '
      source /usr/local/lib/labgate/labgate-common.sh
      labgate_queue_event session-close "$1" 3
    ' _ "${CREDENTIAL_A}"; then
    /usr/bin/rm -f -- "${control}/block-curl"
    kill "${flush_pid}" >/dev/null 2>&1 || true
    wait "${flush_pid}" 2>/dev/null || true
    return 1
  fi
  kill -0 "${flush_pid}" 2>/dev/null || return 1
  [[ -f /var/lib/labgate/outbox/event-v2-000000000000000002 ]] || return 1

  /usr/bin/rm -f -- "${control}/block-curl"
  wait "${flush_pid}" || return 1
  [[ ! -e /var/lib/labgate/outbox/event-v2-000000000000000001 \
    && -f /var/lib/labgate/outbox/event-v2-000000000000000002 ]] || return 1
  expect_success 'next worker snapshot drains later event' \
    /usr/local/sbin/guest-webhook-flush.sh || return 1
  [[ ! -e /var/lib/labgate/outbox/event-v2-000000000000000002 ]] || return 1
  assert_equal "$(<"${control}/last-curl-payload")" \
    "{\"credentialId\":\"${CREDENTIAL_A}\",\"stateVersion\":3}" \
    'terminal payload after blocked worker'
}

test_legacy_outbox_terminal_migration() {
  local archive_count archived_count

  reset_fixture || return 1
  printf 'session-open\t%s\t2\n' "${CREDENTIAL_A}" \
    >/var/lib/labgate/outbox/event-1000000000000000000-11-ABC123
  printf 'session-close\t%s\t3\n' "${CREDENTIAL_A}" \
    >/var/lib/labgate/outbox/event-1000000000000000001-11-ABC124
  printf 'session-open\t%s\t2\n' "${CREDENTIAL_B}" \
    >/var/lib/labgate/outbox/event-1000000000000000002-12-ABC125
  chmod 0600 /var/lib/labgate/outbox/event-*

  expect_success 'compact validated legacy queue while dormant' bash -c '
    source /usr/local/lib/labgate/labgate-common.sh
    labgate_acquire_lock
    labgate_migrate_legacy_outbox
  ' || return 1
  [[ -f /var/lib/labgate/outbox/event-v2-000000000000000001 \
    && -f /var/lib/labgate/outbox/event-v2-000000000000000002 ]] || return 1
  assert_equal "$(</var/lib/labgate/outbox/event-v2-000000000000000001)" \
    "$(printf 'session-close\t%s\t3' "${CREDENTIAL_A}")" \
    'first compacted terminal event' || return 1
  assert_equal "$(</var/lib/labgate/outbox/event-v2-000000000000000002)" \
    "$(printf 'session-close\t%s\t3' "${CREDENTIAL_B}")" \
    'second compacted terminal event' || return 1
  [[ -f /var/lib/labgate/tombstones/${CREDENTIAL_A} \
    && -f /var/lib/labgate/tombstones/${CREDENTIAL_B} \
    && ! -e /var/lib/labgate/outbox-legacy-migration ]] || return 1
  [[ -z $(/usr/bin/find /var/lib/labgate/outbox -maxdepth 1 -type f \
    -name 'event-[0-9]*' -print -quit) ]] || return 1
  archive_count=$(/usr/bin/find /var/lib/labgate -maxdepth 1 -type d \
    -name 'legacy-outbox-archive.*' | /usr/bin/wc -l)
  archived_count=$(/usr/bin/find /var/lib/labgate -mindepth 2 -type f \
    -path '*/legacy-outbox-archive.*/event-*' | /usr/bin/wc -l)
  assert_equal "${archive_count}" 1 'legacy archive count' || return 1
  assert_equal "${archived_count}" 3 'archived legacy event count' || return 1

  # A journal surviving an interrupted run is authoritative even after all old
  # event files have already moved or drained.
  reset_fixture || return 1
  printf '%s\n' "${CREDENTIAL_C}" >/var/lib/labgate/outbox-legacy-migration
  chmod 0600 /var/lib/labgate/outbox-legacy-migration
  expect_success 'resume migration from persistent journal' bash -c '
    source /usr/local/lib/labgate/labgate-common.sh
    labgate_acquire_lock
    labgate_migrate_legacy_outbox
  ' || return 1
  [[ -f /var/lib/labgate/outbox/event-v2-000000000000000001 \
    && -f /var/lib/labgate/tombstones/${CREDENTIAL_C} \
    && ! -e /var/lib/labgate/outbox-legacy-migration ]] || return 1
  assert_equal "$(</var/lib/labgate/outbox/event-v2-000000000000000001)" \
    "$(printf 'session-close\t%s\t3' "${CREDENTIAL_C}")" \
    'journal recovery terminal event'
}

test_legacy_outbox_invalid_backlog_fails_closed() {
  reset_fixture || return 1
  printf 'session-open\t%s\t2\n' "${CREDENTIAL_A}" \
    >/var/lib/labgate/outbox/event-bad
  chmod 0600 /var/lib/labgate/outbox/event-bad
  expect_failure 'unknown outbox filename is quarantined' bash -c '
    source /usr/local/lib/labgate/labgate-common.sh
    labgate_inventory_outbox
  ' || return 1
  [[ -f /var/lib/labgate/outbox/event-bad \
    && ! -e /var/lib/labgate/outbox-sequence ]] || return 1

  reset_fixture || return 1
  printf 'session-open\t%s\t3\n' "${CREDENTIAL_A}" \
    >/var/lib/labgate/outbox/event-1000000000000000000-11-ABC123
  chmod 0600 /var/lib/labgate/outbox/event-1000000000000000000-11-ABC123
  expect_failure 'invalid legacy payload is retained' bash -c '
    source /usr/local/lib/labgate/labgate-common.sh
    labgate_acquire_lock
    labgate_migrate_legacy_outbox
  ' || return 1
  [[ -f /var/lib/labgate/outbox/event-1000000000000000000-11-ABC123 \
    && ! -e /var/lib/labgate/outbox-legacy-migration ]] || return 1

  reset_fixture || return 1
  printf 'session-open\t%s\t2\n' "${CREDENTIAL_A}" \
    >/var/lib/labgate/outbox/event-1000000000000000000-11-ABC123
  chmod 0600 /var/lib/labgate/outbox/event-1000000000000000000-11-ABC123
  printf 'active\n' >"${control}/session-status"
  expect_failure 'active physical session blocks legacy migration' bash -c '
    source /usr/local/lib/labgate/labgate-common.sh
    labgate_acquire_lock
    labgate_migrate_legacy_outbox
  ' || return 1
  [[ -f /var/lib/labgate/outbox/event-1000000000000000000-11-ABC123 \
    && ! -e /var/lib/labgate/outbox-legacy-migration \
    && ! -e /var/lib/labgate/outbox-sequence ]] || return 1

  reset_fixture || return 1
  printf 'partial\n' >/var/lib/labgate/outbox/.event-crash-remnant
  chmod 0600 /var/lib/labgate/outbox/.event-crash-remnant
  expect_failure 'unpublished crash remnant requires review' bash -c '
    source /usr/local/lib/labgate/labgate-common.sh
    labgate_inventory_outbox
  ' || return 1
  [[ -f /var/lib/labgate/outbox/.event-crash-remnant ]]
}

test_static_polkit_policy() {
  local actual close_write_line expected open_write_line rule setup

  rule=/mnt/source/machine-setup/00-labgate-deny-guest.rules
  setup=/mnt/source/machine-setup/setup-machine.sh
  expected='polkit.addRule(function(action, subject) {
    if (subject.user === "guest") {
        return polkit.Result.NO;
    }
});'
  actual=$(<"${rule}") || return 1
  assert_equal "${actual}" "${expected}" 'exact guest-only Polkit rule' || return 1
  bash -n "${setup}" || return 1
  grep -Fq 'readonly POLKIT_RULES_DIRECTORY=/etc/polkit-1/rules.d' "${setup}" || return 1
  grep -Fq 'pkaction --version' "${setup}" || return 1
  grep -Fq 'timeout --signal=KILL 5 pkaction' "${setup}" || return 1
  grep -Fq '"${SCRIPT_DIRECTORY}/00-labgate-deny-guest.rules" "${POLKIT_RULE}"' \
    "${setup}" || return 1
  grep -Fq 'installed LabGate Polkit rule differs from the committed artifact' \
    "${setup}" || return 1
  grep -Fq "$(printf "'%s'" '%u')" "${setup}" || return 1
  grep -Fq "$(printf "'%s'" '%a')" "${setup}" || return 1
  grep -Fq 'visudo -c >/dev/null' "${setup}" || return 1
  grep -Fq 'sudo -n -l -U guest' "${setup}" || return 1
  grep -Fq 'sudo_audit_expected="User guest is not allowed to run sudo on ${sudo_audit_hostname}."' \
    "${setup}" || return 1
  grep -Fq 'PermitUserEnvironment no' \
    /mnt/source/machine-setup/sshd-labgate-guest.conf || return 1
  if grep -Fq "printf '    PermitUserEnvironment no\\n'" "${setup}"; then
    return 1
  fi
  grep -Fq 'passwd -l provisioner' "${setup}" || return 1
  grep -Fq "PAM_PROVISIONER_DENY_LINE='account requisite pam_succeed_if.so quiet user != provisioner'" \
    "${setup}" || return 1
  grep -Fq 'for auth_failure_module in pam_faillock.so pam_tally2.so pam_tally.so' \
    "${setup}" || return 1
  grep -Fq 'labgate_prepare_guest_login_authentication' "${setup}" || return 1
  grep -Fq 'enabled_state=$(systemctl is-enabled "${unit}"' "${setup}" || return 1
  grep -Fq 'guest-webhook-flush.path guest-webhook-flush.timer' "${setup}" || return 1
  grep -Fq 'guest-webhook-flush.path guest-webhook-flush.service guest-webhook-flush.timer' \
    "${setup}" || return 1
  grep -Fq 'PathChanged=/var/lib/labgate/outbox' \
    /mnt/source/machine-setup/guest-webhook-flush.path || return 1
  grep -Fq 'OnUnitActiveSec=10s' \
    /mnt/source/machine-setup/guest-webhook-flush.timer || return 1
  grep -Fq "readonly PAM_OPEN_HOOK_LINE='session required pam_exec.so quiet type=open_session /usr/local/sbin/guest-session-hook.sh'" \
    "${setup}" || return 1
  grep -Fq "readonly PAM_CLOSE_HOOK_LINE='session required pam_exec.so quiet type=close_session /usr/local/sbin/guest-session-hook.sh'" \
    "${setup}" || return 1
  grep -Fq "readonly LEGACY_PAM_HOOK_LINE='session required pam_exec.so quiet /usr/local/sbin/guest-session-hook.sh'" \
    "${setup}" || return 1
  grep -Fq "readonly LEGACY_PAM_HOOK_NO_QUIET_LINE='session required pam_exec.so /usr/local/sbin/guest-session-hook.sh'" \
    "${setup}" || return 1
  grep -Fq 'install_session_hooks "${pam_file}"' "${setup}" || return 1
  grep -Fq 'display-manager PAM open/close hooks were not installed exactly once' \
    "${setup}" || return 1
  grep -Fq -- '-v open_hook="${PAM_OPEN_HOOK_LINE}"' "${setup}" || return 1
  grep -Fq -- '-v close_hook="${PAM_CLOSE_HOOK_LINE}"' "${setup}" || return 1
  ! grep -Eq -- '-v (open|close)=' "${setup}" || return 1
  open_write_line=$(grep -n -m1 'printf.*PAM_OPEN_HOOK_LINE' "${setup}" | cut -d: -f1) || return 1
  close_write_line=$(grep -n -m1 'printf.*PAM_CLOSE_HOOK_LINE' "${setup}" | cut -d: -f1) || return 1
  (( open_write_line < close_write_line )) || return 1
  grep -Fq 'disabled|masked|not-found' "${setup}" || return 1
  grep -Fq 'ssh-keygen -lf "${LABGATE_SSH_HOST_PUBLIC_KEY}" -E sha256' \
    /usr/local/lib/labgate/labgate-common.sh || return 1
  grep -Fq '"sshHostKeySha256":"%s"' "${setup}" || return 1
  grep -Fq 'explicit legacy-null rekey procedure' "${setup}" || return 1
  grep -Fq 'LABGATE_MAX_PENDING_TTL_SECONDS=86400' \
    /usr/local/lib/labgate/labgate-common.sh || return 1
  grep -Fq 'LABGATE_EXPIRY_CLOCK_SKEW_SECONDS=60' \
    /usr/local/lib/labgate/labgate-common.sh || return 1
  grep -Fq 'labgate_validate_api_origin "${api_url}"' "${setup}" || return 1
  grep -Fq 'labgate_validate_registration_secret "${LABGATE_REGISTRATION_SECRET:-}"' \
    "${setup}" || return 1
  grep -Fq 'new_temporary_file webhook_curl_config' "${setup}" || return 1
  ! grep -Fq 'new_temporary_file temporary' "${setup}"
}

test_pam_hook_rewrite_awk_compatibility() {
  local pam_file=/etc/pam.d/labgate-hook-rewrite-test

  printf '%s\n' \
    'session required pam_exec.so quiet type=open_session /usr/local/sbin/guest-session-hook.sh' \
    'session required pam_exec.so quiet type=close_session /usr/local/sbin/guest-session-hook.sh' \
    'session required pam_exec.so quiet /usr/local/sbin/guest-session-hook.sh' \
    'session required pam_exec.so /usr/local/sbin/guest-session-hook.sh' \
    'auth required pam_deny.so' >"${pam_file}" || return 1
  chmod 0644 "${pam_file}" || return 1

  expect_success 'PAM hook rewrites use portable AWK variable names' bash -c '
    PAM_OPEN_HOOK_LINE="session required pam_exec.so quiet type=open_session /usr/local/sbin/guest-session-hook.sh"
    PAM_CLOSE_HOOK_LINE="session required pam_exec.so quiet type=close_session /usr/local/sbin/guest-session-hook.sh"
    LEGACY_PAM_HOOK_LINE="session required pam_exec.so quiet /usr/local/sbin/guest-session-hook.sh"
    LEGACY_PAM_HOOK_NO_QUIET_LINE="session required pam_exec.so /usr/local/sbin/guest-session-hook.sh"
    die() { printf "%s\n" "$1" >&2; exit 1; }
    new_temporary_file() {
      local destination_name=$1 temporary
      temporary=$(mktemp) || exit 1
      chmod 0600 "${temporary}" || exit 1
      printf -v "${destination_name}" "%s" "${temporary}"
    }
    eval "$(sed -n "/^remove_known_pam_hooks() {/,/^}/p" /mnt/source/machine-setup/setup-machine.sh)"
    eval "$(sed -n "/^install_session_hooks() {/,/^}/p" /mnt/source/machine-setup/setup-machine.sh)"
    remove_known_pam_hooks /etc/pam.d/labgate-hook-rewrite-test
    [[ $(cat /etc/pam.d/labgate-hook-rewrite-test) == "auth required pam_deny.so" ]] || exit 1
    printf "%s\n" \
      "${LEGACY_PAM_HOOK_LINE}" \
      "auth required pam_deny.so" \
      "${PAM_CLOSE_HOOK_LINE}" >/etc/pam.d/labgate-hook-rewrite-test
    install_session_hooks /etc/pam.d/labgate-hook-rewrite-test
    expected=$(printf "%s\n%s\n%s" \
      "${PAM_OPEN_HOOK_LINE}" \
      "auth required pam_deny.so" \
      "${PAM_CLOSE_HOOK_LINE}")
    [[ $(cat /etc/pam.d/labgate-hook-rewrite-test) == "${expected}" ]]
  '
}

test_gdm_smartcard_alternate_policy() {
  local pam_file

  /usr/bin/find /etc/pam.d -mindepth 1 -delete || return 1
  for pam_file in \
    gdm-password \
    gdm-autologin \
    gdm-fingerprint \
    gdm-smartcard-pkcs11-exclusive \
    gdm-smartcard-sssd-exclusive \
    gdm-smartcard-sssd-or-password \
    gdm-launch-environment; do
    printf 'auth required pam_deny.so\n' >"/etc/pam.d/${pam_file}" || return 1
  done
  ln -s gdm-smartcard-sssd-exclusive /etc/pam.d/gdm-smartcard || return 1

  expect_success 'reviewed Ubuntu GDM smart-card services are denied' bash -c '
    PAM_GUEST_DENY_LINE="account requisite pam_succeed_if.so quiet user != guest"
    PAM_PROVISIONER_DENY_LINE="account requisite pam_succeed_if.so quiet user != provisioner"
    die() { printf "%s\n" "$1" >&2; exit 1; }
    prepend_unique_line() {
      local destination=$1 line=$2
      grep -Fqx "${line}" "${destination}" || printf "%s\n" "${line}" >>"${destination}"
    }
    eval "$(sed -n "/^install_alternate_display_manager_denials() {/,/^}/p" /mnt/source/machine-setup/setup-machine.sh)"
    install_alternate_display_manager_denials /etc/pam.d/gdm-password
  ' || return 1

  [[ -L /etc/pam.d/gdm-smartcard \
    && $(readlink -f /etc/pam.d/gdm-smartcard) == /etc/pam.d/gdm-smartcard-sssd-exclusive ]] \
    || return 1
  for pam_file in \
    gdm-autologin \
    gdm-fingerprint \
    gdm-smartcard-pkcs11-exclusive \
    gdm-smartcard-sssd-exclusive \
    gdm-smartcard-sssd-or-password; do
    [[ $(grep -Fxc 'account requisite pam_succeed_if.so quiet user != guest' "/etc/pam.d/${pam_file}") == 1 \
      && $(grep -Fxc 'account requisite pam_succeed_if.so quiet user != provisioner' "/etc/pam.d/${pam_file}") == 1 ]] \
      || return 1
  done

  printf 'auth required pam_deny.so\n' >/etc/pam.d/gdm-face || return 1
  expect_failure 'unknown GDM PAM service still fails closed' bash -c '
    PAM_GUEST_DENY_LINE="account requisite pam_succeed_if.so quiet user != guest"
    PAM_PROVISIONER_DENY_LINE="account requisite pam_succeed_if.so quiet user != provisioner"
    die() { printf "%s\n" "$1" >&2; exit 1; }
    prepend_unique_line() { return 0; }
    eval "$(sed -n "/^install_alternate_display_manager_denials() {/,/^}/p" /mnt/source/machine-setup/setup-machine.sh)"
    install_alternate_display_manager_denials /etc/pam.d/gdm-password
  ' || return 1
  grep -Fq 'unknown gdm PAM authentication path gdm-face' "${command_stderr}"
}

run_case() {
  local description=$1 function_name=$2

  test_count=$((test_count + 1))
  if "${function_name}"; then
    printf 'ok %s - %s\n' "${test_count}" "${description}"
  else
    printf 'not ok %s - %s\n' "${test_count}" "${description}"
    failure_count=$((failure_count + 1))
  fi
}

run_inner() {
  fixture=$1

  mount_fixture "${fixture}" || {
    printf 'could not establish the private machine-test mounts\n' >&2
    return 1
  }
  control=/mnt/control
  command_stdout=/mnt/command.stdout
  command_stderr=/mnt/command.stderr
  export LABGATE_TEST_CONTROL_DIRECTORY=${control}

  run_case 'exact password configuration and issue validation' test_issue_validation
  run_case 'pending v1 to active v2 to revoked v3' test_complete_lifecycle
  run_case 'state versions reject stale and downgrade transitions' test_monotonic_state
  run_case 'active physical sessions ignore the credential deadline' test_active_ignores_deadline
  run_case 'unused pending credentials expire and lock locally' test_pending_expiry
  run_case 'pending clock failures lock before physical login' test_pending_clock_failures
  run_case 'active clock failures preserve only real logind sessions' test_active_clock_failures
  run_case 'revoke is generation-scoped and refuses active sessions' test_revoke_guards
  run_case 'no-state compensation writes a terminal tombstone' test_compensation_tombstone
  run_case 'tombstone history prevents delayed resurrection' test_tombstone_history
  run_case 'forced-command dispatcher accepts only exact command shapes' test_dispatcher
  run_case 'heartbeat JSON reports the exact active generation' test_heartbeat_json
  run_case 'no-state heartbeat proves local safety and corrupt state stays quarantined' test_heartbeat_no_state_safety
  run_case 'PAM close failures secure the account and generation' test_pam_close_fail_secure
  run_case 'PAM open failures immediately secure the guest account' test_pam_open_fail_secure
  run_case 'guest account changes are denied without blocking root' test_guest_account_change_policy
  run_case 'secure paths remove linger before process cleanup and reject persistence' test_guest_linger_safety
  run_case 'runtime, IPC, keyring, and mailbox state is bounded and cleared' test_guest_external_state_boundary
  run_case 'persistent guest home survives PAM open and close without tmpfs' test_persistent_guest_home_mode
  run_case 'guest-home mode validation and drained-only changes' test_guest_home_mode_validation_and_drain_gate
  run_case 'credential issue resets PAM counters and non-expiring aging' test_guest_authentication_reset
  run_case 'persistent outbox sequencing survives clock and counter faults' test_outbox_monotonic_sequence
  run_case 'outbox producers never wait for worker network I/O' test_outbox_producer_does_not_wait_for_network
  run_case 'legacy outbox migration journals, terminates, and archives safely' test_legacy_outbox_terminal_migration
  run_case 'unsafe legacy backlog and active sessions fail closed' test_legacy_outbox_invalid_backlog_fails_closed
  run_case 'private lifecycle directories reject symlinks and enforce metadata' test_private_directory_initialization
  run_case 'local Ed25519 host-key fingerprints are canonical and root-persisted' test_ssh_host_key_fingerprint_boundary
  run_case 'setup API origins and first-registration secrets fail early' test_setup_configuration_boundaries
  run_case 'Polkit rule and installer boundary match the committed policy' test_static_polkit_policy
  run_case 'PAM hook rewrites use AWK-compatible names and preserve hook order' test_pam_hook_rewrite_awk_compatibility
  run_case 'Ubuntu GDM smart-card alternatives are denied and unknown paths fail closed' test_gdm_smartcard_alternate_policy

  printf '1..%s\n' "${test_count}"
  if (( failure_count != 0 )); then
    printf '%s of %s machine-setup tests failed\n' "${failure_count}" "${test_count}" >&2
    return 1
  fi
  printf '%s machine-setup tests passed in a private rootless namespace\n' "${test_count}"
}

if [[ ${1:-} == --inner ]]; then
  [[ $# -eq 2 ]] || exit 2
  run_inner "$2"
else
  [[ $# -eq 0 ]] || {
    printf 'usage: %s\n' "${0##*/}" >&2
    exit 2
  }
  run_outer
fi
