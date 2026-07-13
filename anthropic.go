package capuchin

import (
	"context"
	"encoding/json"
	"os"

	"github.com/anthropics/anthropic-sdk-go"
)

// The Anthropic adapter — implements the harness CallModelActivity contract against
// the Messages API. ONE model turn per call; the workflow owns the loop, executes
// tools, and calls back with tool results in the transcript.
//
// NOTE on thinking: adaptive thinking is deliberately NOT enabled yet. Our neutral
// transcript stores only text/tool_use/tool_result blocks; replaying an assistant
// tool_use turn without its preceding thinking block would be rejected. Enabling
// thinking requires carrying thinking blocks through the transcript first (TODO).

const defaultAnthropicModel = anthropic.ModelClaudeOpus4_8

func anthropicConfigured() bool {
	return os.Getenv("ANTHROPIC_API_KEY") != "" || os.Getenv("ANTHROPIC_AUTH_TOKEN") != ""
}

// ActiveModelLabel describes which model adapter the current environment selects —
// what the `capuchin dev` banner shows.
func ActiveModelLabel() string {
	switch os.Getenv("CAPUCHIN_MODEL") {
	case "mock":
		return "mock (forced via CAPUCHIN_MODEL=mock)"
	case "anthropic":
		return "anthropic (" + string(defaultAnthropicModel) + ")"
	}
	if anthropicConfigured() {
		return "anthropic (" + string(defaultAnthropicModel) + ")"
	}
	return "mock (no API key — set ANTHROPIC_API_KEY for real responses)"
}

func anthropicCallModel(ctx context.Context, input CallModelInput) (CallModelResult, error) {
	client := anthropic.NewClient() // reads ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN

	params := anthropic.MessageNewParams{
		Model:     defaultAnthropicModel,
		MaxTokens: 16000,
		Messages:  toAnthropicMessages(input.Messages),
	}
	if input.Model != "" {
		params.Model = anthropic.Model(input.Model) // AgentConfig.Model pass-through
	}
	if input.System != "" {
		params.System = []anthropic.TextBlockParam{{Text: input.System}}
	}
	if len(input.Tools) > 0 {
		params.Tools = toAnthropicTools(input.Tools)
	}

	resp, err := client.Messages.New(ctx, params)
	if err != nil {
		return CallModelResult{}, err
	}

	msg := Message{Role: "assistant", Content: []ContentBlock{}}
	for _, block := range resp.Content {
		switch v := block.AsAny().(type) {
		case anthropic.TextBlock:
			msg.Content = append(msg.Content, ContentBlock{Type: "text", Text: v.Text})
		case anthropic.ToolUseBlock:
			in := map[string]any{}
			// Input is raw JSON — always parse, never string-match.
			_ = json.Unmarshal([]byte(v.JSON.Input.Raw()), &in)
			msg.Content = append(msg.Content, ContentBlock{
				Type: "tool_use", ToolUseID: v.ID, Name: v.Name, Input: in,
			})
		}
	}

	return CallModelResult{Message: msg, StopReason: mapStopReason(resp.StopReason)}, nil
}

// toAnthropicMessages maps the harness's neutral transcript to Messages API params.
// Harness roles: user (text), assistant (text + tool_use), tool (tool_result — the
// API expects those in a USER message).
func toAnthropicMessages(msgs []Message) []anthropic.MessageParam {
	out := []anthropic.MessageParam{}
	for _, m := range msgs {
		blocks := []anthropic.ContentBlockParamUnion{}
		for _, b := range m.Content {
			switch b.Type {
			case "text":
				if b.Text != "" {
					blocks = append(blocks, anthropic.NewTextBlock(b.Text))
				}
			case "tool_use":
				blocks = append(blocks, anthropic.NewToolUseBlock(b.ToolUseID, b.Input, b.Name))
			case "tool_result":
				blocks = append(blocks, anthropic.NewToolResultBlock(b.ToolUseID, b.Content, b.IsError))
			}
		}
		if len(blocks) == 0 {
			continue
		}
		if m.Role == "assistant" {
			out = append(out, anthropic.NewAssistantMessage(blocks...))
		} else {
			// user AND tool roles both map to API user messages
			out = append(out, anthropic.NewUserMessage(blocks...))
		}
	}
	return out
}

func toAnthropicTools(tools []ToolDef) []anthropic.ToolUnionParam {
	out := []anthropic.ToolUnionParam{}
	for _, t := range tools {
		props, _ := t.InputSchema["properties"].(map[string]any)
		tp := anthropic.ToolParam{
			Name:        t.Name,
			Description: anthropic.String(t.Description),
			InputSchema: anthropic.ToolInputSchemaParam{Properties: props},
		}
		if req, ok := t.InputSchema["required"].([]any); ok {
			required := make([]string, 0, len(req))
			for _, r := range req {
				if s, ok := r.(string); ok {
					required = append(required, s)
				}
			}
			if len(required) > 0 {
				tp.InputSchema.Required = required
			}
		}
		out = append(out, anthropic.ToolUnionParam{OfTool: &tp})
	}
	return out
}

func mapStopReason(sr anthropic.StopReason) string {
	switch sr {
	case anthropic.StopReasonToolUse:
		return "tool_use"
	case anthropic.StopReasonMaxTokens:
		return "max_tokens"
	case anthropic.StopReasonRefusal:
		return "refusal"
	default:
		return "end_turn"
	}
}
