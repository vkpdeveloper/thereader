"""Version 0.3 warm-call benchmark; outputs never overwrite version 0.2 evidence.

Run each worker sequentially in its own pinned venv, on an otherwise idle host.
One warm-up followed by three measured conversions. Timing scopes differ and
are recorded explicitly; these are configuration ranks, not market rankings.
"""
import argparse,contextlib,hashlib,importlib.metadata,io,json,platform,statistics,subprocess,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
DEST=ROOT/'eval/pdf/coverage-v03';LOCAL=ROOT/'test-corpus/pdf/coverage-v03/bench'
CORPUS=json.loads((ROOT/'eval/pdf/real-world/corpus.json').read_text())

def modern(engine):
    if engine=='docling':
        from docling.document_converter import DocumentConverter,PdfFormatOption
        from docling.datamodel.base_models import InputFormat,DocumentStream
        from docling.datamodel.pipeline_options import PdfPipelineOptions,TableFormerMode
        from docling.datamodel.accelerator_options import AcceleratorOptions,AcceleratorDevice
        options=PdfPipelineOptions(do_ocr=False,do_table_structure=True,generate_picture_images=True)
        options.table_structure_options.mode=TableFormerMode.ACCURATE
        options.accelerator_options=AcceleratorOptions(num_threads=4,device=AcceleratorDevice.CPU)
        converter=DocumentConverter(format_options={InputFormat.PDF:PdfFormatOption(pipeline_options=options)})
        from docling_core.types.doc import ImageRefMode
        def convert(path,data):
            doc=converter.convert(DocumentStream(name=path.name,stream=io.BytesIO(data))).document
            md=doc.export_to_markdown(image_mode=ImageRefMode.EMBEDDED)
            return md,doc
        return convert,'docling','CPU, 4 threads; accurate tables; OCR off; Markdown with embedded pictures; warm conversion + Markdown export'
    if engine=='marker':
        import os
        os.environ['TORCH_DEVICE']='cpu'
        os.environ['FAST_DETECTOR_DEVICE']='cpu'
        os.environ['FAST_LAYOUT_NUM_THREADS']='4'
        os.environ['OMP_NUM_THREADS']='4'
        import torch
        torch.set_num_threads(4)
        from marker.models import create_model_dict
        from marker.converters.pdf import PdfConverter
        from marker.renderers.markdown import MarkdownRenderer
        from marker.renderers.json import JSONRenderer
        models=create_model_dict()
        captured={}
        class CaptureMarkdown(MarkdownRenderer):
            def __call__(self,document):
                captured['document']=document
                return super().__call__(document)
        converter=PdfConverter(artifact_dict=models,config={'mode':'fast','disable_ocr':True,'use_llm':False,'pdftext_workers':1})
        converter.renderer=CaptureMarkdown
        def convert(path,data):
            result=converter(str(path));return result.markdown,result
        # Native structured output is exported only after timing. It is the
        # same processed document, not another inference run or a gold repair.
        convert.native_json=lambda:converter.resolve_dependencies(JSONRenderer)(captured['document']).model_dump_json()
        return convert,'marker-pdf','CPU fast mode (CPU default), OCR/LLM off; 4 torch threads, 1 pdftext worker; Markdown + image extraction; input file reading included'

def main():
    ap=argparse.ArgumentParser();ap.add_argument('engine');ap.add_argument('--binary',default='/tmp/pdf-extractor-v030');ap.add_argument('--repeats',type=int,default=3);ap.add_argument('--ids',default='');args=ap.parse_args()
    DEST.mkdir(parents=True,exist_ok=True)
    cpu=platform.processor() or platform.machine()
    if sys.platform=='darwin':
        try:cpu=subprocess.check_output(['sysctl','-n','machdep.cpu.brand_string'],text=True,stderr=subprocess.DEVNULL).strip() or cpu
        except (OSError,subprocess.CalledProcessError):pass
    engine=args.engine;records=[r for r in CORPUS if not args.ids or r['id'] in args.ids.split(',')]
    outdir=LOCAL/engine;outdir.mkdir(parents=True,exist_ok=True)
    rows=[]
    if engine!='pdf-extractor':
        if engine in ('docling','marker'):convert,package,scope=modern(engine);version=importlib.metadata.version(package)
        else:
            from bench import load_engine
            convert,version,scope=load_engine(engine)
    for r in records:
        path=ROOT/r['file'];data=path.read_bytes()
        if hashlib.sha256(data).hexdigest()!=r['sha256']:raise ValueError('Corpus source changed')
        output=outdir/(r['id']+'.json');times=[]
        if engine=='pdf-extractor':
            p=subprocess.run([args.binary,'-format','json','-repeat',str(args.repeats+1),'-out',str(output),str(path)],capture_output=True,text=True,check=True,timeout=300)
            d=json.loads(output.read_text());timing=json.loads(p.stderr.splitlines()[-1]);times=timing['samplesMs'][1:];version=d['version'];scope=timing['scope'];content=d['markdown'];stats=d['stats']
        else:
            for n in range(args.repeats+1):
                with contextlib.redirect_stdout(sys.stderr):
                    start=time.perf_counter()
                    if engine in ('docling','marker'):content,d=convert(path,data)
                    else:d=convert(data);content=d['text']
                    elapsed=(time.perf_counter()-start)*1000
                if n:times.append(elapsed)
            (outdir/(r['id']+'.md')).write_text(content)
            if engine=='docling':output.write_text(d.model_dump_json())
            elif engine=='marker':output.write_text(convert.native_json())
            else:output.write_text(json.dumps(d,ensure_ascii=False))
            stats=None
        row={'engine':engine,'version':version,'id':r['id'],'pages':r['pages'],'scope':scope,'samplesMs':times,'medianMs':statistics.median(times),'msPerPage':statistics.median(times)/r['pages'],'outputSha256':hashlib.sha256(output.read_bytes()).hexdigest(),'stats':stats}
        rows.append(row);print(engine,r['id'],row['msPerPage'],flush=True)
        (DEST/f'timing-{engine}.json').write_text(json.dumps({'platform':platform.platform(),'cpu':cpu,'binarySHA256':hashlib.sha256(Path(args.binary).read_bytes()).hexdigest() if engine=='pdf-extractor' else None,'python':sys.version,'warmups':1,'repeats':args.repeats,'rows':rows},indent=2)+'\n')
if __name__=='__main__':main()
