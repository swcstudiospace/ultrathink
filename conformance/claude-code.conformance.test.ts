// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { createClaudeCodeSubject } from "./claude-code-subject.ts";
import { registerConformance } from "./suite.ts";

registerConformance(createClaudeCodeSubject());
