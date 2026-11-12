// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { createGrokBuildSubject } from "./grok-build-subject.ts";
import { registerConformance } from "./suite.ts";

registerConformance(createGrokBuildSubject());
