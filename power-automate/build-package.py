#!/usr/bin/env python3
"""Build a Power Automate 'Import Package (Legacy)' zip from the flow definition.

Usage:  python3 build-package.py [output.zip]

Produces the folder layout the legacy import wizard expects:

    manifest.json
    Microsoft.Flow/flows/<flow-id>/definition.json
    Microsoft.Flow/flows/<flow-id>/apisMap.json
"""
import json
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "test-request-approval-flow.json")
OUTPUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "TestRequestApproval.zip")

FLOW_NAME = "Test request approval"
# Stable ids so re-running the script produces a byte-identical package.
FLOW_ID = "1b7c9a30-4f21-4d8e-9a55-8c3f0e6d21aa"
FLOW_RESOURCE = "3f6d81c2"
CREATED_TIME = "2026-08-23T00:00:00.0000000Z"

APIS = [
    ("shared_sharepointonline", "SharePoint", "b1a4c0e5"),
    ("shared_approvals", "Approvals", "c2b5d1f6"),
    ("shared_office365", "Office 365 Outlook", "d3c6e207"),
]

with open(SOURCE) as fh:
    definition = json.load(fh)["definition"]

connection_references = {
    api: {
        "connectionName": api.replace("shared_", "shared-").replace("_", "-"),
        "source": "Embedded",
        "id": "/providers/Microsoft.PowerApps/apis/" + api,
        "tier": "NotSpecified",
    }
    for api, _label, _res in APIS
}

flow_definition = {
    "name": FLOW_ID,
    "id": "/providers/Microsoft.Flow/flows/" + FLOW_ID,
    "type": "Microsoft.Flow/flows",
    "properties": {
        "apiId": "/providers/Microsoft.PowerApps/apis/shared_logicflows",
        "displayName": FLOW_NAME,
        "definition": definition,
        "connectionReferences": connection_references,
        "flowFailureAlertSubscribed": False,
    },
}

resources = {
    FLOW_RESOURCE: {
        "id": "/providers/Microsoft.Flow/flows/" + FLOW_ID,
        "name": FLOW_ID,
        "type": "Microsoft.Flow/flows",
        "suggestedCreationType": "New",
        "creationType": "New, Existing, Update",
        "details": {"displayName": FLOW_NAME},
        "configurableBy": "User",
        "hierarchy": "Root",
        "dependsOn": [res for _api, _label, res in APIS],
    }
}
for api, label, res in APIS:
    resources[res] = {
        "id": "/providers/Microsoft.PowerApps/apis/" + api,
        "name": api,
        "type": "Microsoft.PowerApps/apis",
        "suggestedCreationType": "Existing",
        "creationType": "Existing",
        "details": {"displayName": label},
        "configurableBy": "System",
        "hierarchy": "Child",
        "dependsOn": [],
    }

manifest = {
    "schema": "1.0",
    "details": {
        "displayName": FLOW_NAME,
        "description": "Approval flow for the SharePoint list 'Test'.",
        "createdTime": CREATED_TIME,
        "packageTelemetryId": "8e0f5b41-6d33-4a19-b7c8-2f9014ad55e3",
        "creator": "",
        "sourceEnvironment": "",
    },
    "resources": resources,
}

apis_map = {api: "/providers/Microsoft.PowerApps/apis/" + api for api, _l, _r in APIS}

base = "Microsoft.Flow/flows/" + FLOW_ID
files = {
    "manifest.json": manifest,
    base + "/definition.json": flow_definition,
    base + "/apisMap.json": apis_map,
}

with zipfile.ZipFile(OUTPUT, "w", zipfile.ZIP_DEFLATED) as zf:
    for path, payload in files.items():
        info = zipfile.ZipInfo(path, date_time=(2026, 8, 23, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        zf.writestr(info, json.dumps(payload, indent=2))

print("wrote", OUTPUT)
