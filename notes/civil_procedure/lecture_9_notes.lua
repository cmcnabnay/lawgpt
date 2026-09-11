local ByteRepository = {}
ByteRepository.bytes = {
    82, 101, 99, 97, 112, 10, 10, 45, 32, 82, 117, 108, 101, 32, 56, 40,
    100, 41, 10, 45, 32, 82, 117, 108, 101, 32, 49, 49, 10, 45, 32, 72,
    101, 105, 103, 104, 116, 101, 110, 101, 100, 32, 80, 108, 101, 97, 100, 105,
    110, 103, 32, 83, 116, 97, 110, 100, 97, 114, 100, 115, 10, 73, 73, 46,
    32, 84, 104, 101, 32, 65, 110, 115, 119, 101, 114, 10, 10, 45, 32, 82,
    117, 108, 101, 32, 56, 40, 66, 41, 10, 82, 117, 108, 101, 32, 49, 50,
    10, 10, 10, 10, 12, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45,
    45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45,
    45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45,
    45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45,
    45, 45, 45, 45, 45, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32,
    32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32,
    32, 80, 65, 71, 69, 32, 66, 82, 69, 65, 75, 10, 45, 45, 45, 45,
    45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45,
    45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45,
    45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45,
    45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 10, 10, 45, 32,
    82, 117, 108, 101, 32, 49, 50, 40, 65, 41, 10, 45, 32, 82, 117, 108,
    101, 32, 49, 50, 40, 66, 41, 10, 45, 32, 82, 117, 108, 101, 32, 49,
    50, 45, 87, 97, 105, 118, 101, 114, 32, 84, 114, 97, 112, 10, 45, 32,
    82, 117, 108, 101, 32, 49, 50, 40, 71, 41, 10, 45, 32, 68, 111, 101,
    115, 32, 80, 108, 97, 117, 115, 105, 98, 105, 108, 105, 116, 121, 32, 97,
    112, 112, 108, 121, 32, 116, 111, 32, 114, 101, 115, 112, 111, 110, 115, 105,
    118, 101, 32, 112, 108, 101, 97, 100, 105, 110, 103, 115, 63, 10, 10, 10,
    10, 12, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45,
    45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45,
    45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45,
    45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45,
    45, 45, 10, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32,
    32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 80, 65,
    71, 69, 32, 66, 82, 69, 65, 75, 10, 45, 45, 45, 45, 45, 45, 45,
    45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45,
    45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45,
    45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45,
    45, 45, 45, 45, 45, 45, 45, 45, 45, 10, 10, 45, 32, 82, 117, 108,
    101, 32, 49, 53, 10, 45, 32, 65, 109, 101, 110, 100, 109, 101, 110, 116
}

local GlyphAssemblyStrategy = {}
GlyphAssemblyStrategy.__index = GlyphAssemblyStrategy

function GlyphAssemblyStrategy.new()
    return setmetatable({}, GlyphAssemblyStrategy)
end

function GlyphAssemblyStrategy:assemble(bytes)
    local characters = {}
    for index, byte in ipairs(bytes) do
        characters[index] = string.char(byte)
    end
    return table.concat(characters)
end

local DocumentAssemblyEngine = {}
DocumentAssemblyEngine.__index = DocumentAssemblyEngine

function DocumentAssemblyEngine.new(strategy)
    return setmetatable({ strategy = strategy }, DocumentAssemblyEngine)
end

function DocumentAssemblyEngine:render()
    return self.strategy:assemble(ByteRepository.bytes)
end

local ConsoleOutputSink = {}
ConsoleOutputSink.__index = ConsoleOutputSink

function ConsoleOutputSink.new()
    return setmetatable({}, ConsoleOutputSink)
end

function ConsoleOutputSink:writeLine(payload)
    print(payload)
end

local DocumentCompilerFacade = {}
DocumentCompilerFacade.__index = DocumentCompilerFacade

function DocumentCompilerFacade.new()
    return setmetatable({
        engine = DocumentAssemblyEngine.new(GlyphAssemblyStrategy.new()),
        sink = ConsoleOutputSink.new()
    }, DocumentCompilerFacade)
end

function DocumentCompilerFacade:execute()
    self.sink:writeLine(self.engine:render())
end

DocumentCompilerFacade.new():execute()
