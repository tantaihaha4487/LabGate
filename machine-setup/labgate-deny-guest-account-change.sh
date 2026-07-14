#!/bin/sh
set -eu

PATH=/usr/sbin:/usr/bin:/sbin:/bin
LC_ALL=C
export PATH LC_ALL

# pam_exec runs without seteuid, so this is the real identity that invoked the
# setuid account-management utility. Root maintenance must remain possible,
# while the temporary shared desktop identity must not make persistent account
# changes to its password, login shell, or GECOS data.
if [ "${PAM_USER-}" = guest ] && [ "$(/usr/bin/id -ru)" -ne 0 ]; then
  exit 1
fi

exit 0
