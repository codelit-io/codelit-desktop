import Foundation
import HuggingFace
import MLXHuggingFace
import MLXLLM
import MLXLMCommon
import Tokenizers

private let defaultModel = "mlx-community/Qwen3-0.6B-4bit"
private let defaultRevision = "73e3e38d981303bc594367cd910ea6eb48349da8"
private let helperVersion = "0.3.2"

private struct StructuredAnswer: Codable {
    let summary: String
    let items: [String]

    private enum CodingKeys: String, CodingKey {
        case summary
        case items
    }

    init(summary: String, items: [String]) {
        self.summary = summary
        self.items = items
    }

    init(from decoder: any Swift.Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        summary = try container.decode(String.self, forKey: .summary)
        if let values = try? container.decode([String].self, forKey: .items) {
            items = values
        } else if let values = try? container.decode([FlexibleItem].self, forKey: .items) {
            items = values.map { $0.value }
        } else {
            items = []
        }
    }

    func encode(to encoder: any Swift.Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(summary, forKey: .summary)
        try container.encode(items, forKey: .items)
    }
}

private struct FlexibleItem: Decodable {
    let value: String

    private enum CodingKeys: String, CodingKey {
        case item
        case value
        case text
        case name
    }

    init(from decoder: any Swift.Decoder) throws {
        if let single = try? decoder.singleValueContainer(),
           let value = try? single.decode(String.self)
        {
            self.value = value
            return
        }

        let container = try decoder.container(keyedBy: CodingKeys.self)
        for key in [CodingKeys.item, .value, .text, .name] {
            if let value = try container.decodeIfPresent(String.self, forKey: key),
               !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            {
                self.value = value
                return
            }
        }
        throw DecodingError.dataCorruptedError(
            forKey: .item,
            in: container,
            debugDescription: "Each item must be text or contain a text value."
        )
    }
}

private struct PreparedModel: Codable {
    let status: String
    let model: String
    let revision: String
}

private struct ModelBenchmark: Codable {
    let schemaVersion: Int
    let model: String
    let revision: String
    let schemaAdherence: Bool
    let toolCalling: Bool
    let contextTokens: Int
    let tokensPerSecond: Double
    let benchmarkedAt: String
}

private struct BenchmarkSample {
    var output = ""
    var toolCalls: [ToolCall] = []
    var completion: GenerateCompletionInfo?
}

private enum HelperError: LocalizedError {
    case missingPrompt
    case invalidStructuredOutput(String)

    var errorDescription: String? {
        switch self {
        case .missingPrompt:
            "Pass a non-empty prompt with --prompt."
        case .invalidStructuredOutput(let output):
            "The local model did not return the required JSON shape: \(output.prefix(400))"
        }
    }
}

private struct Arguments {
    var model = defaultModel
    var revision = defaultRevision
    var prompt = ""
    var prepareModel = false
    var benchmark = false

    init(_ values: [String]) throws {
        var index = 0
        while index < values.count {
            switch values[index] {
            case "--model" where index + 1 < values.count:
                model = values[index + 1]
                index += 2
            case "--revision" where index + 1 < values.count:
                revision = values[index + 1]
                index += 2
            case "--prompt" where index + 1 < values.count:
                prompt = values[index + 1]
                index += 2
            case "--prepare-model":
                prepareModel = true
                index += 1
            case "--benchmark":
                benchmark = true
                index += 1
            default:
                index += 1
            }
        }
        prompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard prepareModel || benchmark || !prompt.isEmpty else { throw HelperError.missingPrompt }
    }
}

private func collectBenchmarkSample(
    _ stream: AsyncThrowingStream<Generation, Error>
) async throws -> BenchmarkSample {
    var sample = BenchmarkSample()
    for try await generation in stream {
        switch generation {
        case .chunk(let text):
            sample.output += text
        case .toolCall(let call):
            sample.toolCalls.append(call)
        case .info(let completion):
            sample.completion = completion
        }
    }
    return sample
}

private func benchmarkModel(
    _ model: ModelContainer,
    modelID: String,
    revision: String
) async throws -> ModelBenchmark {
    writeError("Benchmarking structured output...")
    let schemaSession = ChatSession(
        model,
        instructions: "Return only valid compact JSON. Never use Markdown or explanatory text.",
        generateParameters: .init(maxTokens: 96, temperature: 0)
    )
    let schemaSample = try await collectBenchmarkSample(
        schemaSession.streamDetails(
            to: "/no_think\nReturn {\"summary\":\"benchmark-ready\",\"items\":[\"local\"]} exactly.",
            images: [],
            videos: []
        )
    )
    let structured = decodeStructuredAnswer(from: schemaSample.output)
    let schemaAdherence = structured?.summary == "benchmark-ready"
        && structured?.items == ["local"]

    writeError("Benchmarking bounded context recall...")
    let marker = "codelit-context-7"
    let contextBody = Array(
        repeating: "release scope owner verification receipt rollback evidence",
        count: 160
    ).joined(separator: " ")
    let contextSession = ChatSession(
        model,
        instructions: "Return only valid compact JSON. Never use Markdown or explanatory text.",
        generateParameters: .init(maxTokens: 96, temperature: 0)
    )
    let contextSample = try await collectBenchmarkSample(
        contextSession.streamDetails(
            to: "/no_think\nRemember this marker: \(marker).\n\(contextBody)\nReturn JSON with the marker as summary and an empty items array.",
            images: [],
            videos: []
        )
    )
    let contextAnswer = decodeStructuredAnswer(from: contextSample.output)
    let contextTokens = contextAnswer?.summary == marker
        ? contextSample.completion?.promptTokenCount ?? 0
        : 0

    writeError("Benchmarking tool-call formatting...")
    let tool: ToolSpec = [
        "type": "function",
        "function": [
            "name": "verify_release",
            "description": "Verify a release identifier",
            "parameters": [
                "type": "object",
                "properties": [
                    "release": ["type": "string"] as [String: any Sendable]
                ] as [String: any Sendable],
                "required": ["release"],
            ] as [String: any Sendable],
        ] as [String: any Sendable],
    ]
    let toolSession = ChatSession(
        model,
        instructions: "Use the provided tool when the user asks to verify a release.",
        generateParameters: .init(maxTokens: 64, temperature: 0),
        tools: [tool]
    )
    let toolSample = try await collectBenchmarkSample(
        toolSession.streamDetails(
            to: "/no_think\nVerify release alpha-7 with the provided tool.",
            images: [],
            videos: []
        )
    )
    let toolCalling = toolSample.toolCalls.contains {
        $0.function.name == "verify_release"
    }
    let measuredTokensPerSecond = schemaSample.completion?.tokensPerSecond ?? 0

    return ModelBenchmark(
        schemaVersion: 1,
        model: modelID,
        revision: revision,
        schemaAdherence: schemaAdherence,
        toolCalling: toolCalling,
        contextTokens: contextTokens,
        tokensPerSecond: measuredTokensPerSecond.isFinite
            ? max(0, measuredTokensPerSecond)
            : 0,
        benchmarkedAt: ISO8601DateFormatter().string(from: Date())
    )
}

private func writeError(_ value: String) {
    guard let data = "\(value)\n".data(using: .utf8) else { return }
    FileHandle.standardError.write(data)
}

private func decodeStructuredAnswer(from response: String) -> StructuredAnswer? {
    if let data = response.data(using: .utf8),
       let answer = try? JSONDecoder().decode(StructuredAnswer.self, from: data)
    {
        return answer
    }

    let bytes = Array(response.utf8)
    var start: Int?
    var depth = 0
    var isInsideString = false
    var isEscaped = false
    for (index, byte) in bytes.enumerated() {
        if start == nil {
            guard byte == Character("{").asciiValue else { continue }
            start = index
            depth = 1
            continue
        }
        if isInsideString {
            if isEscaped {
                isEscaped = false
            } else if byte == Character("\\").asciiValue {
                isEscaped = true
            } else if byte == Character("\"").asciiValue {
                isInsideString = false
            }
            continue
        }
        if byte == Character("\"").asciiValue {
            isInsideString = true
        } else if byte == Character("{").asciiValue {
            depth += 1
        } else if byte == Character("}").asciiValue {
            depth -= 1
            if depth == 0, let start {
                return try? JSONDecoder().decode(
                    StructuredAnswer.self,
                    from: Data(bytes[start...index])
                )
            }
        }
    }
    return nil
}

private func normalizedAnswer(from response: String) -> StructuredAnswer? {
    if let structured = decodeStructuredAnswer(from: response), !structured.summary.isEmpty {
        return structured
    }

    var visible = response.trimmingCharacters(in: .whitespacesAndNewlines)
    while let start = visible.range(of: "<think>", options: .caseInsensitive),
          let end = visible.range(
              of: "</think>",
              options: .caseInsensitive,
              range: start.upperBound..<visible.endIndex
          )
    {
        visible.removeSubrange(start.lowerBound..<end.upperBound)
        visible = visible.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    guard !visible.isEmpty,
          !visible.localizedCaseInsensitiveContains("<think>"),
          !visible.hasPrefix("{") && !visible.hasPrefix("[")
    else {
        return nil
    }
    var summary = ""
    var byteCount = 0
    for character in visible {
        let fragment = String(character)
        let fragmentBytes = fragment.utf8.count
        if byteCount + fragmentBytes > 2_800 { break }
        summary.append(character)
        byteCount += fragmentBytes
    }
    guard !summary.isEmpty else { return nil }
    return StructuredAnswer(summary: summary, items: [])
}

@main
private struct CodelitMLXHelper {
    static func main() async {
        do {
            let rawArguments = Array(CommandLine.arguments.dropFirst())
            if rawArguments == ["--version"] {
                print("Codelit MLX helper \(helperVersion) (\(defaultModel)@\(defaultRevision))")
                return
            }
            if rawArguments.first == "--normalize-output", rawArguments.count == 2 {
                guard let answer = normalizedAnswer(from: rawArguments[1]) else {
                    throw HelperError.invalidStructuredOutput(rawArguments[1])
                }
                let output = try JSONEncoder().encode(answer)
                FileHandle.standardOutput.write(output)
                FileHandle.standardOutput.write(Data([0x0a]))
                return
            }
            let arguments = try Arguments(rawArguments)
            writeError("Loading \(arguments.model) with MLX on this Mac...")
            let model = try await #huggingFaceLoadModelContainer(
                configuration: .init(id: arguments.model, revision: arguments.revision)
            ) { progress in
                let percent = Int(progress.fractionCompleted * 100)
                if percent % 10 == 0 {
                    writeError("Model download \(percent)%")
                }
            }
            if arguments.prepareModel {
                let prepared = PreparedModel(
                    status: "ready",
                    model: arguments.model,
                    revision: arguments.revision
                )
                let output = try JSONEncoder().encode(prepared)
                FileHandle.standardOutput.write(output)
                FileHandle.standardOutput.write(Data([0x0a]))
                return
            }
            if arguments.benchmark {
                let benchmark = try await benchmarkModel(
                    model,
                    modelID: arguments.model,
                    revision: arguments.revision
                )
                let output = try JSONEncoder().encode(benchmark)
                FileHandle.standardOutput.write(output)
                FileHandle.standardOutput.write(Data([0x0a]))
                return
            }
            let session = ChatSession(
                model,
                instructions: "Answer directly for the user. Never expose private reasoning or hidden analysis.",
                generateParameters: .init(maxTokens: 192, temperature: 0)
            )
            var response = ""
            for try await chunk in session.streamResponse(
                to: "/no_think\n\(arguments.prompt)\nReturn only the concise user-facing answer."
            ) {
                response += chunk
                if !chunk.isEmpty,
                   let encoded = try? JSONEncoder().encode(chunk),
                   let payload = String(data: encoded, encoding: .utf8)
                {
                    writeError("Codelit stream \(payload)")
                }
            }
            guard let answer = normalizedAnswer(from: response),
                  !answer.summary.isEmpty
            else {
                throw HelperError.invalidStructuredOutput(response)
            }
            let output = try JSONEncoder().encode(answer)
            FileHandle.standardOutput.write(output)
            FileHandle.standardOutput.write(Data([0x0a]))
        } catch {
            writeError(error.localizedDescription)
            Foundation.exit(EXIT_FAILURE)
        }
    }
}
