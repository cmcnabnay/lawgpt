object CodePointRepository {
    // Stored as chunked string literals rather than one intArrayOf(...) of
    // every character's code point -- see buildKotlinSource in lawgpt.html
    // for why.
    private val textChunks: List<String> = listOf(
        "[0m[1mRule 26: Framework for Discovery[0m\n1. Some required disclosures for the basis for your claims or\ndefenses\n2. Parties plan discovery, conferring with each other\n3. The scope of discovery is: nonprivileged, relevant, and\nproportional information\n4. The court can adjust the limits of discovery to fit the case\n5. Parties can be sanctioned for improper actions\n[0m[1mTypes of Discovery[0m\n- Depositions (Rule 30)\n- Interrogatories (Rule 33)\n- Documents, ESI, Tangible Things, Property (Rule 34)\n- Mental and Physical Examinations (Rule 35)\n[0m[1mEnforcing Discovery[0m\n- 37(a) for noncompliance with discovery, a party must work in\ngood faith with the other party or person to obtain discovery\n- If that fails, may seek order from the court to compel\ndiscovery\n- 37(b), if someone fails to comply with an order compelling\ndiscovery, the court may sanction\n[0m[1mPrivilege[0m\n- Even if some material is relevant and proportional, that\nmaterial is not discoverable if it's privileged\n- The most common privilege is attorney-client privilege\n- Spousal privilege, physician patient privilege, clergy\nprivilege\n[0m[1mAttorney-Client Privilege[0m\nTo be privileged, the communication must:\n1) Involve a client or someone seeking to be a client\n2) be made to a lawyer, or a lawyer's subordinate, acting in\ntheir capacity as a lawyer\n3) be confidential and in the course of seeking legal advice\n4) and the privilege must be claimed and not waived\n- Privilege can be reviewed\n- Privilege belongs to the client, i.e., the client may invoke\nit to shield communications\n[0m[1mWork Product Protection[0m\n- Documents or tangible things prepared in anticipation of\nlitigation or trial, by a lawyer or party or\n[0m[1mHypotheticals[0m\nSeeking representation counts as legal counsel in\nattorney-client privilege\nAfter their client is sued, the defense lawyer interviews\nwitness A, who saw the events from a unique angle. The defense\nlawyer writes a memorandum recording the key factual points from\nwhat the witness said and highlighting how those facts could be\nused in litigation. Witness A tragically passes away a week\nlater. The plaintiff's lawyer requests the memo\nNo"
    )
    val codePoints: IntArray
        get() = textChunks.joinToString("").codePoints().toArray()
}

interface GlyphAssemblyStrategy {
    fun assemble(codePoints: IntArray): String
}

class SequentialGlyphAssemblyStrategy : GlyphAssemblyStrategy {
    override fun assemble(codePoints: IntArray): String {
        val builder = StringBuilder()
        for (codePoint in codePoints) {
            builder.appendCodePoint(codePoint)
        }
        return builder.toString()
    }
}

class DocumentAssemblyEngine(private val strategy: GlyphAssemblyStrategy) {
    fun render(): String = strategy.assemble(CodePointRepository.codePoints)
}

class ConsoleOutputSink {
    fun writeLine(payload: String) = println(payload)
}

class DocumentCompilerFacade {
    private val engine = DocumentAssemblyEngine(SequentialGlyphAssemblyStrategy())
    private val sink = ConsoleOutputSink()

    fun execute() {
        sink.writeLine(engine.render())
    }
}

fun main() {
    DocumentCompilerFacade().execute()
}
