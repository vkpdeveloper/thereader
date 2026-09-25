package com.thereader.gradle;

import org.junit.Test;
import org.objectweb.asm.*;
import java.util.ArrayList;
import java.util.List;
import static org.junit.Assert.*;

public class ReadiumLookupTransformTest {
    @Test public void redirectsOnlyThePinnedCallsWithoutChangingTheOperandStack() {
        List<String> calls = new ArrayList<>();
        ClassVisitor sink = new ClassVisitor(Opcodes.ASM9) {
            @Override public MethodVisitor visitMethod(int a, String n, String d, String s, String[] e) {
                return new MethodVisitor(Opcodes.ASM9) {
                    @Override public void visitMethodInsn(int op, String owner, String name, String desc, boolean itf) {
                        calls.add(op + " " + owner + "." + name + desc);
                    }
                };
            }
        };
        ClassVisitor visitor = ReadiumLookupTransform.visitor(sink);
        MethodVisitor method = visitor.visitMethod(0, "serve", "()V", null, null);
        for (int i = 0; i < 3; i++) {
            method.visitMethodInsn(Opcodes.INVOKEVIRTUAL, "org/readium/r2/shared/publication/Publication", "linkWithHref",
                    "(Lorg/readium/r2/shared/util/Url;)Lorg/readium/r2/shared/publication/Link;", false);
        }
        method.visitMethodInsn(Opcodes.INVOKEVIRTUAL, "unrelated/Class", "linkWithHref", "()V", false);
        visitor.visitEnd();
        assertEquals(4, calls.size());
        assertEquals("184 dk/nota/flutterreadium/PublicationHrefIndex.lookup(Lorg/readium/r2/shared/publication/Publication;Lorg/readium/r2/shared/util/Url;)Lorg/readium/r2/shared/publication/Link;", calls.get(0));
        assertEquals(calls.get(0), calls.get(1));
        assertEquals(calls.get(1), calls.get(2));
        assertEquals("182 unrelated/Class.linkWithHref()V", calls.get(3));
    }

    @Test(expected = IllegalStateException.class) public void failsIfTheUpstreamCallSitesChange() {
        ReadiumLookupTransform.visitor(new ClassVisitor(Opcodes.ASM9) {}).visitEnd();
    }
}
