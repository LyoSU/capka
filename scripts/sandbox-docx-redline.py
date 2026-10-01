#!/usr/bin/env python3
"""docx-redline ORIGINAL EDITED OUTPUT [--author NAME]

Saves EDITED as OUTPUT (.docx) with every difference from ORIGINAL recorded as a
Word tracked change, so the person can accept or reject each edit in Word or
LibreOffice. Rejecting all of them gives back ORIGINAL's text; accepting all gives
EDITED's.

LibreOffice's own Compare Document does the work, which sets the limits:
  - wording changes are marked word by word;
  - a formatting-only change (bold, colour, style) is NOT marked — the output has
    the new formatting, but nothing points at it;
  - a table with any change is marked as the old table deleted and the new one
    inserted, not cell by cell.

Runs its own headless LibreOffice with a throwaway profile under /tmp, so it does
not collide with another soffice in the sandbox and needs no writable $HOME.
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

import uno
from com.sun.star.beans import PropertyValue


def prop(name, value):
    p = PropertyValue()
    p.Name, p.Value = name, value
    return p


def url(path):
    return uno.systemPathToFileUrl(os.path.abspath(path))


def main():
    ap = argparse.ArgumentParser(prog="docx-redline", description=__doc__.split("\n\n")[1])
    ap.add_argument("original")
    ap.add_argument("edited")
    ap.add_argument("output")
    ap.add_argument("--author", default="Capka", help="name shown on every change (default: Capka)")
    a = ap.parse_args()
    for f in (a.original, a.edited):
        if not os.path.isfile(f):
            sys.exit(f"docx-redline: not found: {f}")
    if os.path.abspath(a.output) in (os.path.abspath(a.original), os.path.abspath(a.edited)):
        sys.exit("docx-redline: OUTPUT must be a new file, not one of the inputs")

    work = tempfile.mkdtemp(prefix="docx-redline-")
    pipe = "docx_redline_" + uuid.uuid4().hex[:8]
    office = subprocess.Popen(
        ["/usr/bin/soffice", "--headless", "--invisible", "--norestore", "--nologo", "--nodefault",
         f"-env:UserInstallation=file://{work}/profile",
         f"--accept=pipe,name={pipe};urp;StarOffice.ComponentContext"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env={**os.environ, "HOME": work},
    )
    desktop = None
    try:
        local = uno.getComponentContext()
        resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
        for _ in range(240):
            try:
                ctx = resolver.resolve(f"uno:pipe,name={pipe};urp;StarOffice.ComponentContext")
                break
            except Exception:
                if office.poll() is not None:
                    sys.exit("docx-redline: LibreOffice exited before it was ready")
                time.sleep(0.25)
        else:
            sys.exit("docx-redline: LibreOffice did not start within 60 s")
        smgr = ctx.ServiceManager
        # LibreOffice signs each change with its user name — empty in a fresh
        # profile, which Word shows as "Unknown Author".
        config = smgr.createInstanceWithContext("com.sun.star.configuration.ConfigurationProvider", ctx)
        user = config.createInstanceWithArguments("com.sun.star.configuration.ConfigurationUpdateAccess",
                                                  (prop("nodepath", "/org.openoffice.UserProfile/Data"),))
        user.setPropertyValue("givenname", a.author)
        user.setPropertyValue("sn", "")
        user.commitChanges()
        desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
        doc = desktop.loadComponentFromURL(url(a.edited), "_blank", 0, (prop("Hidden", True),))
        if doc is None or not hasattr(doc, "getRedlines"):
            sys.exit(f"docx-redline: not a text document: {a.edited}")
        # ...but Compare takes the author and time from the edited file's metadata
        # when it has one: for a file written by python-docx, "python-docx", 2013.
        props = doc.getDocumentProperties()
        props.ModifiedBy = a.author
        now = time.gmtime()
        stamp = uno.createUnoStruct("com.sun.star.util.DateTime")
        stamp.Year, stamp.Month, stamp.Day, stamp.Hours, stamp.Minutes, stamp.Seconds = now[:6]
        props.ModificationDate = stamp
        dispatcher = smgr.createInstanceWithContext("com.sun.star.frame.DispatchHelper", ctx)
        dispatcher.executeDispatch(doc.getCurrentController().getFrame(), ".uno:CompareDocuments", "", 0,
                                   (prop("URL", url(a.original)), prop("NoAcceptDialog", True)))
        changes = doc.getRedlines().getCount()
        doc.storeToURL(url(a.output), (prop("FilterName", "MS Word 2007 XML"),))
        doc.close(True)
        print(f"{changes} tracked change(s) -> {a.output}")
    finally:
        try:
            if desktop is not None:
                desktop.terminate()
        except Exception:
            pass  # the bridge drops as soffice exits; that is the expected way out
        try:
            office.wait(timeout=15)
        except subprocess.TimeoutExpired:
            office.kill()
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
