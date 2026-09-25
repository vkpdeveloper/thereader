package com.thereader.gradle;

import com.android.build.api.instrumentation.AsmClassVisitorFactory;
import com.android.build.api.instrumentation.ClassContext;
import com.android.build.api.instrumentation.ClassData;
import com.android.build.api.instrumentation.InstrumentationParameters;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

/** Pinned Readium 3.2 WebView hot path; leaves the SDK and its public API intact. */
public abstract class ReadiumLookupTransform
        implements AsmClassVisitorFactory<InstrumentationParameters.None> {
    @Override public boolean isInstrumentable(ClassData data) {
        return data.getClassName().equals("org.readium.r2.navigator.epub.WebViewServer");
    }

    @Override public ClassVisitor createClassVisitor(ClassContext context, ClassVisitor next) {
        return visitor(next);
    }

    static ClassVisitor visitor(ClassVisitor next) {
        return new ClassVisitor(Opcodes.ASM9, next) {
            private int replacements;
            @Override public MethodVisitor visitMethod(int access, String name, String descriptor,
                                                        String signature, String[] exceptions) {
                return new MethodVisitor(Opcodes.ASM9,
                        super.visitMethod(access, name, descriptor, signature, exceptions)) {
                    @Override public void visitMethodInsn(int opcode, String owner, String name,
                                                          String descriptor, boolean isInterface) {
                        if (opcode == Opcodes.INVOKEVIRTUAL
                                && owner.equals("org/readium/r2/shared/publication/Publication")
                                && name.equals("linkWithHref")
                                && descriptor.equals("(Lorg/readium/r2/shared/util/Url;)Lorg/readium/r2/shared/publication/Link;")) {
                            // Same operands and return type: no frame or stack-size changes.
                            super.visitMethodInsn(Opcodes.INVOKESTATIC,
                                    "dk/nota/flutterreadium/PublicationHrefIndex", "lookup",
                                    "(Lorg/readium/r2/shared/publication/Publication;Lorg/readium/r2/shared/util/Url;)Lorg/readium/r2/shared/publication/Link;", false);
                            replacements++;
                        } else {
                            super.visitMethodInsn(opcode, owner, name, descriptor, isInterface);
                        }
                    }
                };
            }
            @Override public void visitEnd() {
                // Fail on upstream changes instead of silently losing the optimization.
                if (replacements != 3) {
                    throw new IllegalStateException("Readium 3.2 WebViewServer lookup sites changed: " + replacements);
                }
                super.visitEnd();
            }
        };
    }
}
