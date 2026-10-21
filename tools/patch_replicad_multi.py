"""RazorCAD's changes to replicad's multi-threaded kernel loader (replicad_multi.js, replicad commit a0bc495).

The same two hooks as in RazorCAD's replicad_single.js (used by app/js/ocfree.js to free kernel objects for real),
and the number of threads a kernel starts (and the processor count OpenCascade sees) taken from Module.razorcadThreads (RazorCAD sets it from the PC: see
app/js/machine.js), instead of always every processor thread, so several kernels don't each start one per thread.

    python tools/patch_replicad_multi.py <replicad_multi.js as published> app/vendor/replicad/replicad_multi.js

The published file: github.com/sgenoud/replicad, packages/replicad-opencascadejs/dist/replicad_multi.js at commit
a0bc495676b65ef79ad8ab496238fa145fd0ff67.
"""
import sys

src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding='utf-8').read()
reps = [
    # a handle made: told to RazorCAD (ocfree.js)
    ("b.count={value:1};return Ge(Object.create(a,{rb:{value:b,writable:!0}}))}",
     "b.count={value:1};var razorcadH=Ge(Object.create(a,{rb:{value:b,writable:!0}}));h.razorcadOnHandle?.(razorcadH);return razorcadH}"),
    # each class's raw destructor kept (ocfree.js)
    ("n=W(n);f=Y(e,f);k&&=Y(g,k);l&&=Y(m,l);r=Y(t,r);",
     "n=W(n);f=Y(e,f);k&&=Y(g,k);l&&=Y(m,l);var razorcadDtor=r;r=Y(t,r);"),
    ("var A=new Qe(n,w,C,r,x,f,k,l);if(A.Ib)",
     "var A=new Qe(n,w,C,r,x,f,k,l);(h.razorcadDtors??={})[n]=razorcadDtor;if(A.Ib)"),
    # the threads started: as RazorCAD asks
    ("function od(){for(var a=navigator.hardwareConcurrency;a--;)ed();",
     "function od(){for(var a=h.razorcadThreads??navigator.hardwareConcurrency;a--;)ed();"),
    # and the processor count OpenCascade sees (its thread pool takes one thread per processor): the same, or it
    # asks for more threads than were started, and a thread can't be started while the kernel waits for it
    ("var oc=()=>p?require(\"node:os\").cpus().length:navigator.hardwareConcurrency;",
     "var oc=()=>p?require(\"node:os\").cpus().length:h.razorcadThreads??navigator.hardwareConcurrency;"),
]
for a, b in reps:
    n = s.count(a)
    assert n == 1, (n, a[:70])
    s = s.replace(a, b)
open(dst, 'w', encoding='utf-8', newline='\n').write(s)
print('patched', dst)
